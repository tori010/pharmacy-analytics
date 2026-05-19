const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { verifyToken, authorizeRoles } = require('../middlewares/verifyToken');
const { validateRequest, schemas } = require('../middlewares/validator');
const axios = require('axios');

// =================== Task 3: Paginated Medicine List ===================
// FIX: Added offset/limit pagination via ?page=&limit= query params (default limit 50).
// Returns total count alongside data so the frontend can build pagination controls.
router.get('/', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const limit  = Math.max(1, parseInt(req.query.limit, 10) || 50);
    const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
    const offset = (page - 1) * limit;

    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM Medicine');
    const [medicines]   = await pool.query(
      'SELECT * FROM Medicine ORDER BY name ASC LIMIT ? OFFSET ?',
      [limit, offset]
    );

    const cleanedMedicines = medicines.map(med => ({
      ...med,
      quantity: parseFloat(med.quantity),
      sellingPrice: parseFloat(med.sellingPrice),
      purchasePrice: parseFloat(med.purchasePrice)
    }));

    res.json({
      data: cleanedMedicines,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// البحث بالباركود (عشان جهاز الباركود في شاشة البيع)
router.get('/search/:barcode', verifyToken, authorizeRoles('admin', 'pharmacist', 'cashier'), async (req, res) => {
  try {
    const [medicine] = await pool.query('SELECT * FROM Medicine WHERE barcode = ?', [req.params.barcode]);
    if (medicine.length === 0) return res.status(404).json({ error: 'الدواء غير موجود' });
    medicine[0].quantity = parseFloat(medicine[0].quantity);
    medicine[0].sellingPrice = parseFloat(medicine[0].sellingPrice);
    medicine[0].purchasePrice = parseFloat(medicine[0].purchasePrice);
    res.json(medicine[0]);
  } catch (err) { res.status(500).json({ error: 'حدث خطأ في البحث' }); }
});

// إضافة دواء جديد
router.post('/', verifyToken, authorizeRoles('admin', 'pharmacist'), validateRequest(schemas.medicine), async (req, res) => {
  try {
    const {
      name, barcode, expiryDate, quantity, purchasePrice, sellingPrice,
      requiresPrescription, supplierId,
      pillCount, stripCount, manufacturer, genericName, medicineForm
    } = req.body;

    const sql = `INSERT INTO Medicine 
      (id, name, barcode, expiryDate, quantity, purchasePrice, sellingPrice, requiresPrescription, supplierId, pillCount, stripCount, manufacturer, genericName, medicineForm) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    await pool.query(sql, [
      uuidv4(), name, barcode, expiryDate, quantity, purchasePrice, sellingPrice,
      requiresPrescription || false, supplierId || null,
      pillCount || 0, stripCount || 0, manufacturer || null, genericName || null, medicineForm || null
    ]);

    res.json({ message: 'تم إضافة الدواء بنجاح' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'الباركود مسجل مسبقاً' });
    res.status(500).json({ error: err.message });
  }
});

// تعديل دواء موجود
router.put('/:id', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const { quantity, sellingPrice } = req.body;
    await pool.query('UPDATE Medicine SET quantity = ?, sellingPrice = ? WHERE id = ?', [quantity, sellingPrice, req.params.id]);
    res.json({ message: 'تم التعديل بنجاح' });
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

// مسح دواء
router.delete('/:id', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM Medicine WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'الدواء غير موجود' });
    res.json({ message: 'تم مسح الدواء بنجاح' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') return res.status(400).json({ error: 'مرتبط بفواتير مبيعات سابقة!' });
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// =================== Task 4: Axios Timeout on Generic Suggestions ===================
// FIX: Added a strict 5000ms timeout to the axios request.
// Timeout errors are caught separately and return a descriptive Arabic message.
router.get('/generic-suggestions', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const { term } = req.query;
    if (!term || term.length < 2) return res.json([]);

    const response = await axios.get(
      `https://clinicaltables.nlm.nih.gov/api/rxterms/v3/search?terms=${term}`,
      { timeout: 5000 }
    );

    const suggestions = response.data[1] || [];
    res.json(suggestions);
  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
      console.warn('RxNav Timeout:', err.message);
      return res.status(504).json({ error: 'الخدمة الطبية الخارجية بطيئة حالياً، يرجى المحاولة مرة أخرى' });
    }
    console.error('RxNav Search Error:', err.message);
    res.status(500).json({ error: 'فشل في الاتصال بقاعدة البيانات الطبية' });
  }
});

module.exports = router;
