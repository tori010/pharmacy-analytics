const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { verifyToken, authorizeRoles } = require('../middlewares/verifyToken');
const { validateRequest, schemas } = require('../middlewares/validator');

router.get('/', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const [suppliers] = await pool.query('SELECT * FROM Supplier');
    res.json(suppliers);
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

router.post('/', verifyToken, authorizeRoles('admin', 'pharmacist'), validateRequest(schemas.supplier), async (req, res) => {
  try {
    const { name, phones, address } = req.body;
    const sql = `INSERT INTO Supplier (id, name, phones, address) VALUES (?, ?, ?, ?)`;
    await pool.query(sql, [uuidv4(), name, JSON.stringify(phones), address]);
    res.json({ message: 'تم الإضافة بنجاح' });
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

router.delete('/:id', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM Supplier WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'المورد غير موجود' });
    res.json({ message: 'تم مسح المورد بنجاح' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') return res.status(400).json({ error: 'المورد مرتبط بأدوية!' });
    res.status(500).json({ error: 'حدث خطأ' }); 
  }
});

module.exports = router;