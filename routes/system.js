const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const { verifyToken, authorizeRoles } = require('../middlewares/verifyToken');

router.get('/notifications', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const [medicines] = await pool.query('SELECT * FROM Medicine');
    let alerts = [];
    const today = new Date();
    medicines.forEach(med => {
      if (med.quantity === 0) alerts.push({ id: uuidv4(), type: 'low_stock', urgent: true, title: `نفاد كمية: ${med.name}`, message: `الكمية صفر! يرجى الطلب فوراً.` });
      else if (med.quantity <= 10) alerts.push({ id: uuidv4(), type: 'low_stock', urgent: false, title: `نقص مخزون: ${med.name}`, message: `متبقي ${med.quantity} علبة فقط.` });

      const expiryDate = new Date(med.expiryDate);
      const diffDays = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
      if (diffDays < 0) alerts.push({ id: uuidv4(), type: 'expiry', urgent: true, title: `دواء منتهي الصلاحية: ${med.name}`, message: `انتهت صلاحيته.` });
      else if (diffDays <= 30) alerts.push({ id: uuidv4(), type: 'expiry', urgent: true, title: `صلاحية توشك على الانتهاء: ${med.name}`, message: `سينتهي قريباً.` });
    });
    res.json(alerts);
  } catch (err) { res.status(500).json({ error: 'حدث خطأ في الخادم' }); }
});

router.get('/reports/today', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const [sales] = await pool.query('SELECT paymentMethod, SUM(total) as amount FROM Sale WHERE DATE(ts) = CURDATE() GROUP BY paymentMethod');
    const [countData] = await pool.query('SELECT COUNT(id) as count FROM Sale WHERE DATE(ts) = CURDATE()');
    let totals = { cash: 0, card: 0, wallet: 0, insurance: 0 };
    let grandTotal = 0;
    sales.forEach(s => { totals[s.paymentMethod] = s.amount; grandTotal += s.amount; });
    res.json({ totals, grandTotal, salesCount: countData[0].count });
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

router.get('/reports/historical', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const { range } = req.query;
    let sql, params;

    if (range === 'day') {
      sql = `SELECT DATE(ts) as date, SUM(total) as total, SUM(profit) as profit, COUNT(id) as count
             FROM Sale WHERE DATE(ts) = CURDATE() GROUP BY DATE(ts) ORDER BY DATE(ts) ASC`;
      params = [];
    } else {
      const daysFilter = range === 'week' ? 7 : 30;
      sql = `SELECT DATE(ts) as date, SUM(total) as total, SUM(profit) as profit, COUNT(id) as count
             FROM Sale WHERE ts >= DATE_SUB(CURDATE(), INTERVAL ? DAY) GROUP BY DATE(ts) ORDER BY DATE(ts) ASC`;
      params = [daysFilter];
    }

    const [data] = await pool.query(sql, params);
    let overall = { total: 0, profit: 0, count: 0 };
    data.forEach(d => { overall.total += d.total; overall.profit += d.profit; overall.count += d.count; });
    res.json({ history: data, overall });
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

router.get('/security', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const [sec] = await pool.query('SELECT setupComplete, recoveryEmail, recoveryPhone FROM ManagerSecurity WHERE id = "1"');
    res.json(sec.length > 0 ? sec[0] : { setupComplete: false });
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

router.post('/security/setup', verifyToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { pin, recoveryEmail, recoveryPhone } = req.body;
    const hashedPin = await bcrypt.hash(pin, 10);
    await pool.query(
      'INSERT INTO ManagerSecurity (id, pinHash, recoveryEmail, recoveryPhone, setupComplete) VALUES ("1", ?, ?, ?, 1) ON DUPLICATE KEY UPDATE pinHash=?, recoveryEmail=?, recoveryPhone=?, setupComplete=1',
      [hashedPin, recoveryEmail, recoveryPhone, hashedPin, recoveryEmail, recoveryPhone]
    );
    res.json({ message: 'تم إعداد الأمان بنجاح' });
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

router.post('/security/reset-pin', verifyToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { oldPin, newPin } = req.body;
    const [sec] = await pool.query('SELECT pinHash FROM ManagerSecurity WHERE id = "1"');
    if (sec.length === 0) return res.status(401).json({ error: 'لم يتم إعداد الأمان بعد' });
    const isValid = await bcrypt.compare(oldPin, sec[0].pinHash);
    if (!isValid) return res.status(401).json({ error: 'الرمز القديم غير صحيح' });
    const hashedNewPin = await bcrypt.hash(newPin, 10);
    await pool.query('UPDATE ManagerSecurity SET pinHash = ? WHERE id = "1"', [hashedNewPin]);
    res.json({ message: 'تم تغيير الرمز بنجاح' });
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

router.post('/daily-closing', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const { date, totals, grandTotal, salesCount, closedByName, closedById, pin } = req.body;
    const [sec] = await pool.query('SELECT pinHash FROM ManagerSecurity WHERE id = "1"');
    if (sec.length === 0) return res.status(401).json({ error: 'إعدادات الأمان غير مكتملة' });
    const isValid = await bcrypt.compare(pin, sec[0].pinHash);
    if (!isValid) return res.status(401).json({ error: 'رقم التعريف الشخصي (PIN) غير صحيح' });
    const sql = `INSERT INTO DailyClosing (id, date, totals, grandTotal, salesCount, closedByName, closedById) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    await pool.query(sql, [uuidv4(), date, JSON.stringify(totals), grandTotal, salesCount, closedByName, closedById]);
    res.json({ message: 'تم تقفيل اليوم بنجاح' });
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

router.post('/logs', verifyToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { actorId, actorName, action, details, severity } = req.body;
    const sql = `INSERT INTO AuditLog (id, actorId, actorName, action, details, severity) VALUES (?, ?, ?, ?, ?, ?)`;
    await pool.query(sql, [uuidv4(), actorId, actorName, action, details, severity]);
    res.json({ message: 'تم تسجيل الحركة' });
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

// =================== التعديل لحل مشكلة الإيرور ===================
// الترتيب الآن يستخدم timestamp ليتوافق مع الداتا بيز
router.get('/logs', verifyToken, authorizeRoles('admin'), async (req, res) => {
  try {
    // شلنا الـ ORDER BY خالص عشان يقرأ البيانات الموجودة بدون مشاكل
    const [logs] = await pool.query('SELECT * FROM AuditLog');
    res.json(logs);
  } catch (err) { 
    console.error("Logs Error:", err.message);
    res.status(500).json({ error: 'تفاصيل الخطأ: ' + err.message }); 
  }
});

router.get('/backup', verifyToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const [users] = await pool.query(
      'SELECT id, username, fullName, email, phone, role, active, expectedDays, dailyHours FROM User'
    );
    const [medicines] = await pool.query(
      'SELECT id, name, barcode, expiryDate, quantity, purchasePrice, sellingPrice, requiresPrescription, supplierId, pillCount, stripCount, manufacturer, genericName, medicineForm FROM Medicine'
    );
    const [sales] = await pool.query(
      'SELECT id, total, cost, profit, paymentMethod, cashierName, cashierId, ts FROM Sale'
    );
    res.json({ users, medicines, sales });
  } catch (err) { res.status(500).json({ error: 'حدث خطأ' }); }
});

module.exports = router;