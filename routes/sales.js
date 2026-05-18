const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { verifyToken, authorizeRoles } = require('../middlewares/verifyToken');
const { validateRequest, schemas } = require('../middlewares/validator');

// ================= Helpers =================
// دالة لحساب الكمية الدقيقة المخصومة أو المضافة بناءً على نوع العبوة
const calculateFractionalQty = (qty, type, stripCount, pillCount) => {
  if (type === 'box') return parseFloat(qty);
  if (type === 'strip') {
    if (!stripCount || stripCount <= 0) throw new Error('بيانات الدواء لا تدعم بيع الشرايط (يجب تحديد عدد الشرايط للعلبة)');
    return parseFloat(qty) / stripCount;
  }
  if (type === 'pill') {
    if (!stripCount || !pillCount || stripCount <= 0 || pillCount <= 0) {
      throw new Error('بيانات الدواء لا تدعم بيع الحبات (يجب تحديد عدد الشرايط والحبات)');
    }
    return parseFloat(qty) / (stripCount * pillCount);
  }
  return parseFloat(qty);
};

// ================= 1. عملية البيع =================
router.post('/', verifyToken, authorizeRoles('admin', 'pharmacist', 'cashier'), validateRequest(schemas.sale), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { paymentMethod, items } = req.body;
    const cashierId = req.user.id;
    const cashierName = req.user.username;
    const saleId = uuidv4();

    let grandTotal = 0;
    let totalCost = 0;
    let totalProfit = 0;

    // تسجيل الفاتورة الأساسية بقيم مبدئية صفر لتفادي خطأ Foreign Key
    await connection.query(
      `INSERT INTO Sale (id, total, cost, profit, paymentMethod, cashierName, cashierId) VALUES (?, 0, 0, 0, ?, ?, ?)`,
      [saleId, paymentMethod, cashierName, cashierId]
    );

    for (let item of items) {
      // جلب بيانات الدواء وعمل Lock لمنع تداخل العمليات
      const [medRows] = await connection.query(
        `SELECT * FROM Medicine WHERE id = ? FOR UPDATE`, 
        [item.medicineId]
      );

      if (medRows.length === 0) throw new Error(`الدواء غير موجود: ${item.medicineId}`);
      const medicine = medRows[0];

      // حساب الكمية المراد خصمها من المخزون
      const deductionQty = calculateFractionalQty(item.qty, item.quantityType, medicine.stripCount, medicine.pillCount);

      if (medicine.quantity < deductionQty) {
        throw new Error(`الكمية غير كافية لدواء: ${medicine.name}. المتاح: ${medicine.quantity.toFixed(4)} علبة.`);
      }

      // حساب السعر والتكلفة لهذا العنصر
      const itemTotalPrice = (medicine.sellingPrice * deductionQty);
      const itemTotalCost = (medicine.purchasePrice * deductionQty);
      const itemProfit = itemTotalPrice - itemTotalCost;

      grandTotal += itemTotalPrice;
      totalCost += itemTotalCost;
      totalProfit += itemProfit;

      // خصم المخزون
      await connection.query(
        `UPDATE Medicine SET quantity = quantity - ? WHERE id = ?`,
        [deductionQty, item.medicineId]
      );

      // تسجيل تفاصيل الفاتورة
      await connection.query(
        `INSERT INTO SaleItem (id, qty, unitPrice, unitCost, medicineName, saleId, medicineId, quantityType, stripCount, pillCount) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(), item.qty, (itemTotalPrice / item.qty), (itemTotalCost / item.qty), 
          medicine.name, saleId, item.medicineId, item.quantityType, 
          medicine.stripCount, medicine.pillCount
        ]
      );
    }

    // تحديث الفاتورة الإجمالية بالمجاميع النهائية
    await connection.query(
      `UPDATE Sale SET total = ?, cost = ?, profit = ? WHERE id = ?`,
      [grandTotal, totalCost, totalProfit, saleId]
    );

    await connection.query(
      `INSERT INTO AuditLog (id, actorId, actorName, action, details, severity) VALUES (UUID(), ?, ?, 'SALE', ?, 'info')`,
      [cashierId, cashierName, `تم بيع فاتورة برقم ${saleId} بقيمة ${grandTotal.toFixed(2)}`]
    );

    await connection.commit();
    res.json({ message: 'تم البيع بنجاح', saleId, total: grandTotal });

  } catch (err) {
    await connection.rollback();
    console.error("Sale Error:", err.message);
    res.status(400).json({ error: err.message || 'فشل إتمام عملية البيع' });
  } finally {
    connection.release();
  }
});

// ================= 2. عملية المرتجع (تعديل اللوجيك بالكامل حسب طلبك) =================
router.post('/return', verifyToken, authorizeRoles('admin', 'pharmacist', 'cashier'), validateRequest(schemas.returnSale), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { saleId, returnedItems } = req.body;
    const cashierId = req.user.id;
    const cashierName = req.user.username;
    const returnId = uuidv4();

    let totalRefund = 0;
    let totalCostRefund = 0;
    let totalProfitRefund = 0;

    // التأكد من وجود الفاتورة الأصلية
    const [saleExists] = await connection.query(`SELECT * FROM Sale WHERE id = ?`, [saleId]);
    if (saleExists.length === 0) throw new Error('الفاتورة الأصلية غير موجودة');

    for (let item of returnedItems) {
      // 1. جلب بيانات العنصر المباع من جدول SaleItem
      const [saleItemRows] = await connection.query(
        `SELECT * FROM SaleItem WHERE id = ? AND saleId = ? FOR UPDATE`,
        [item.saleItemId, saleId]
      );

      if (saleItemRows.length === 0) throw new Error('أحد العناصر غير موجود في هذه الفاتورة');
      const originalItem = saleItemRows[0];

      if (item.qtyToReturn > originalItem.qty) {
        throw new Error(`لا يمكن إرجاع كمية أكبر من المتاحة للصنف: ${originalItem.medicineName}`);
      }

      // 2. جلب بيانات الدواء الحالية من جدول Medicine لمعرفة تفاصيل التعبئة بدقة
      const [medRows] = await connection.query(`SELECT * FROM Medicine WHERE id = ? FOR UPDATE`, [originalItem.medicineId]);
      if (medRows.length === 0) throw new Error(`الدواء لم يعد موجوداً في النظام`);
      const medicine = medRows[0];

      // 3. حساب الكمية الدقيقة لإعادتها لجدول الأدوية (تتحول لكسور العلبة بشكل صحيح)
      const stockAddition = calculateFractionalQty(item.qtyToReturn, originalItem.quantityType, medicine.stripCount, medicine.pillCount);

      // 4. زيادة رصيد الدواء في جدول الأدوية (تم حل مشكلة عدم الزيادة)
      await connection.query(
        `UPDATE Medicine SET quantity = quantity + ? WHERE id = ?`,
        [stockAddition, originalItem.medicineId]
      );

      // 5. حساب القيم المالية المستردة بناءً على سعر وقت البيع
      const itemTotalPrice = originalItem.unitPrice * item.qtyToReturn;
      const itemTotalCost = originalItem.unitCost * item.qtyToReturn;
      const itemProfit = itemTotalPrice - itemTotalCost;

      totalRefund += itemTotalPrice;
      totalCostRefund += itemTotalCost;
      totalProfitRefund += itemProfit;

      // 6. التعامل مع جدول SaleItem (تتتشال أو تتعدل الكمية)
      if (item.qtyToReturn === originalItem.qty) {
        // إذا رجع الكمية كاملة، يتم حذف السطر تماماً من جدول SaleItem
        await connection.query(`DELETE FROM SaleItem WHERE id = ?`, [item.saleItemId]);
      } else {
        // إذا رجع جزء، يتم خصم الكمية من جدول SaleItem
        await connection.query(
          `UPDATE SaleItem SET qty = qty - ? WHERE id = ?`,
          [item.qtyToReturn, item.saleItemId]
        );
      }
    }

    // 7. خصم المبالغ المستردة من الفاتورة الإجمالية في جدول Sale
    await connection.query(
      `UPDATE Sale SET total = total - ?, cost = cost - ?, profit = profit - ? WHERE id = ?`,
      [totalRefund, totalCostRefund, totalProfitRefund, saleId]
    );

    // 8. إذا أصبحت الفاتورة فارغة تماماً (إجمالي قيمتها صفر)، يتم حذفها نهائياً من جدول Sale
    const [checkSale] = await connection.query(`SELECT total FROM Sale WHERE id = ?`, [saleId]);
    if (checkSale.length > 0 && checkSale[0].total <= 0) {
      await connection.query(`DELETE FROM Sale WHERE id = ?`, [saleId]);
    }

    // 9. تسجيل العملية في جدول المرتجع للتوثيق
    await connection.query(
      `INSERT INTO ReturnSale (id, saleId, totalRefund, cashierId, cashierName) VALUES (?, ?, ?, ?, ?)`,
      [returnId, saleId, totalRefund, cashierId, cashierName]
    );

    // تسجيل الـ Log
    await connection.query(
      `INSERT INTO AuditLog (id, actorId, actorName, action, details, severity) VALUES (UUID(), ?, ?, 'RETURN', ?, 'warning')`,
      [cashierId, cashierName, `مرتجع للفاتورة ${saleId} بقيمة ${totalRefund.toFixed(2)} وتحديث الأدوية والبيع.`]
    );

    await connection.commit();
    res.json({ message: 'تم إرجاع الدواء للمخزن وتعديل/حذف البيانات من الفواتير بنجاح', totalRefund });

  } catch (err) {
    await connection.rollback();
    console.error("Return Error:", err.message);
    res.status(400).json({ error: err.message || 'فشل إتمام عملية المرتجع' });
  } finally {
    connection.release();
  }
});

// ================= 3. فحص التعارضات الطبية =================
router.post('/check-interactions', verifyToken, authorizeRoles('admin', 'pharmacist', 'cashier'), async (req, res) => {
  try {
    const { items } = req.body;

    let genericNames = [...new Set(items
      .map(item => item.genericName)
      .filter(name => name && name.trim() !== '')
      .map(name => name.toLowerCase().split(' ')[0])
    )];

    if (genericNames.length < 2) {
      return res.json({ hasInteraction: false, interactions: [] });
    }

    const mockDatabase = {
      'aspirin-warfarin': { severity: 'high', description: 'تحذير: تناول الأسبرين مع الوارفارين يزيد من خطر التعرض لنزيف حاد.' },
      'nitroglycerin-sildenafil': { severity: 'high', description: 'خطر: هبوط حاد في ضغط الدم قد يؤدي إلى الإغماء.' },
      'aspirin-ibuprofen': { severity: 'moderate', description: 'تنبيه: الإيبوبروفين قد يقلل من فاعلية الأسبرين في حماية القلب.' },
      'ciprofloxacin-ibuprofen': { severity: 'moderate', description: 'تنبيه: هذا المزيج قد يزيد من خطر التشنجات العصبية.' }
    };

    genericNames.sort();
    const allInteractions = [];

    for (let i = 0; i < genericNames.length; i++) {
      for (let j = i + 1; j < genericNames.length; j++) {
        const pairKey = `${genericNames[i]}-${genericNames[j]}`;
        if (mockDatabase[pairKey]) {
          allInteractions.push(mockDatabase[pairKey]);
        }
      }
    }

    if (allInteractions.length === 0) {
      return res.json({ hasInteraction: false, interactions: [] });
    }

    res.json({
      hasInteraction: true,
      status: 'warning',
      severity: allInteractions[0].severity,
      message: '⚠️ تنبيه طبي: يوجد تعارض أدوية في هذه الفاتورة',
      details: allInteractions,
      suggestion: 'هل تريد الاستمرار في إتمام البيع رغم هذا التحذير؟'
    });
  } catch (err) {
    console.error('Local Interaction Error:', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء فحص التعارضات الطبية محلياً' });
  }
});

module.exports = router;