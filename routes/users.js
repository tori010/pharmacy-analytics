const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { verifyToken, authorizeRoles } = require('../middlewares/verifyToken');
const { validateRequest, schemas } = require('../middlewares/validator');

router.get('/', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const [users] = await pool.query('SELECT id, username, fullName, email, phone, role, expectedDays, dailyHours, active FROM User');
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ داخلي في السيرفر' });
  }
});

router.post('/', verifyToken, authorizeRoles('admin'), validateRequest(schemas.user), async (req, res) => {
  try {
    const { username, fullName, email, phone, role, password, expectedDays, dailyHours } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const sql = `INSERT INTO User (id, username, fullName, email, phone, role, password, active, dailyHours, expectedDays) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`;

    await pool.query(sql, [
      uuidv4(), username, fullName, email, phone, role, hashedPassword,
      dailyHours || 8, expectedDays || 24
    ]);

    res.json({ message: 'تم إضافة المستخدم وتحديد ساعات العمل بنجاح' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const msg = err.sqlMessage.toLowerCase();
      if (msg.includes('username')) return res.status(400).json({ error: 'اسم المستخدم مسجل مسبقاً' });
      if (msg.includes('phone')) return res.status(400).json({ error: 'رقم الهاتف مسجل مسبقاً' });
      return res.status(400).json({ error: 'البيانات مسجلة مسبقاً' });
    }
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء إضافة الموظف' });
  }
});

router.put('/:id', verifyToken, authorizeRoles('admin'), validateRequest(schemas.updateUser), async (req, res) => {
  try {
    const { id } = req.params;
    const { username, fullName, email, phone, role, password, expectedDays, dailyHours, active } = req.body;

    let sql, params;
    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      sql = `UPDATE User SET username=?, fullName=?, email=?, phone=?, role=?, password=?, dailyHours=?, expectedDays=?, active=? WHERE id=?`;
      params = [username, fullName, email, phone, role, hashedPassword, dailyHours, expectedDays, active, id];
    } else {
      sql = `UPDATE User SET username=?, fullName=?, email=?, phone=?, role=?, dailyHours=?, expectedDays=?, active=? WHERE id=?`;
      params = [username, fullName, email, phone, role, dailyHours, expectedDays, active, id];
    }

    const [result] = await pool.query(sql, params);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json({ message: 'تم تحديث بيانات الموظف بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء التعديل' });
  }
});

router.delete('/:id', verifyToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM User WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json({ message: 'تم حذف الموظف بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في حذف الموظف' });
  }
});

module.exports = router;