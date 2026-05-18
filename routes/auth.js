const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const { JWT_SECRET } = require('../middlewares/verifyToken');
const { validateRequest, schemas } = require('../middlewares/validator');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'محاولات دخول كثيرة، يرجى المحاولة بعد 15 دقيقة' }
});

router.post('/login', loginLimiter, validateRequest(schemas.login), async (req, res) => {
  try {
    const { username, password } = req.body;

    const [users] = await pool.query('SELECT * FROM User WHERE username = ? AND active = 1', [username]);
    if (users.length === 0) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const isValidPassword = await bcrypt.compare(password, users[0].password);
    if (!isValidPassword) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const token = jwt.sign(
      { id: users[0].id, role: users[0].role, username: users[0].username },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    delete users[0].password;
    res.json({ message: 'تم تسجيل الدخول بنجاح', token, user: users[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ داخلي في الخادم' });
  }
});

// تم إزالة تعقيد الـ setupKey وإضافة active و dailyHours لضمان نجاح الـ Login
router.post('/create-first-admin', async (req, res) => {
  try {
    // منع إنشاء أدمن إذا كان يوجد أدمن بالفعل
    const [existing] = await pool.query("SELECT id FROM User WHERE role = 'admin' LIMIT 1");
    if (existing.length > 0) {
      return res.status(400).json({ error: 'يوجد أدمن بالفعل، يرجى تسجيل الدخول.' });
    }

    const hashedPassword = await bcrypt.hash('123456', 10);
    // تم التعديل هنا ليتوافق مع الداتا بيز (active, dailyHours, expectedDays)
    const sql = `INSERT INTO User (id, username, fullName, email, phone, role, password, active, dailyHours, expectedDays) VALUES (UUID(), 'admin_user', 'المدير العام', 'admin@careplus.com', '01000000000', 'admin', ?, 1, 8, 24)`;
    await pool.query(sql, [hashedPassword]);
    
    res.json({ message: 'تم إنشاء أول أدمن بنجاح! اليوزر: admin_user | الباسوورد: 123456' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.json({ message: 'الأدمن موجود بالفعل، يرجى تسجيل الدخول!' });
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ داخلي في الخادم' });
  }
});

module.exports = router;