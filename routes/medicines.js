const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { verifyToken, authorizeRoles } = require('../middlewares/verifyToken');
const { validateRequest, schemas } = require('../middlewares/validator');
const axios = require('axios'); // 🌟 إضافة مكتبة axios

// جلب كل الأدوية
router.get('/', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const [medicines] = await pool.query('SELECT * FROM Medicine');
    res.json(medicines);
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

// البحث بالباركود (عشان جهاز الباركود في شاشة البيع)
router.get('/search/:barcode', verifyToken, authorizeRoles('admin', 'pharmacist', 'cashier'), async (req, res) => {
  try {
    const [medicine] = await pool.query('SELECT * FROM Medicine WHERE barcode = ?', [req.params.barcode]);
    if (medicine.length === 0) return res.status(404).json({ error: 'الدواء غير موجود' });
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

// ==========================================
// 🌟 راوت جلب اقتراحات المواد الفعالة (يعمل بنجاح مع rxterms)
// ==========================================
router.get('/generic-suggestions', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const { term } = req.query; 
    if (!term || term.length < 2) return res.json([]); 

    const response = await axios.get(`https://clinicaltables.nlm.nih.gov/api/rxterms/v3/search?terms=${term}`);
    const suggestions = response.data[1] || []; 
    res.json(suggestions);
  } catch (err) {
    console.error("RxNav Search Error:", err.message);
    res.status(500).json({ error: 'فشل في الاتصال بقاعدة البيانات الطبية' });
  }
});

module.exports = router;