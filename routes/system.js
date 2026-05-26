const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const pool = require('../config/db');
const { verifyToken, authorizeRoles } = require('../middlewares/verifyToken');
const multer = require('multer');
const os = require('os');
const upload = multer({ dest: os.tmpdir() });


router.get('/notifications', verifyToken, authorizeRoles('admin', 'pharmacist'), async (req, res) => {
  try {
    const [medicines] = await pool.query(`
      SELECT id, name, quantity, expiryDate
      FROM Medicine
      WHERE quantity <= 10
         OR expiryDate <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
    `);

    const today = new Date();
    const alerts = [];

    medicines.forEach(med => {
      med.quantity = parseFloat(med.quantity);
      // --- Stock alerts ---
      if (med.quantity === 0) {
        alerts.push({
          id: uuidv4(),
          type: 'low_stock',
          urgent: true,
          title: `نفاد كمية: ${med.name}`,
          message: `الكمية صفر! يرجى الطلب فوراً.`
        });
      } else if (med.quantity <= 10) {
        alerts.push({
          id: uuidv4(),
          type: 'low_stock',
          urgent: false,
          title: `نقص مخزون: ${med.name}`,
          message: `متبقي ${med.quantity} علبة فقط.`
        });
      }

      // --- Expiry alerts ---
      const expiryDate = new Date(med.expiryDate);
      const diffDays = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
      if (diffDays < 0) {
        alerts.push({
          id: uuidv4(),
          type: 'expiry',
          urgent: true,
          title: `دواء منتهي الصلاحية: ${med.name}`,
          message: `انتهت صلاحيته.`
        });
      } else if (diffDays <= 30) {
        alerts.push({
          id: uuidv4(),
          type: 'expiry',
          urgent: true,
          title: `صلاحية توشك على الانتهاء: ${med.name}`,
          message: `سينتهي قريباً.`
        });
      }
    });

    res.json(alerts);
  } catch (err) {
    console.error('Notifications Error:', err.message);
    res.status(500).json({ error: 'حدث خطأ في الخادم' });
  }
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

router.get('/logs', verifyToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 50);
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const offset = (page - 1) * limit;

    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM AuditLog');
    const [logs] = await pool.query(
      'SELECT * FROM AuditLog ORDER BY ts DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );

    res.json({
      data: logs,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Logs Error:', err.message);
    res.status(500).json({ error: 'تفاصيل الخطأ: ' + err.message });
  }
});



router.get('/backup', verifyToken, authorizeRoles('admin'), async (req, res) => {
  try {
    // قائمة الجداول في قاعدة البيانات الخاصة بك
    const tables = ['User', 'Medicine', 'Supplier', 'Sale', 'SaleItem', 'ReturnSale', 'Attendance', 'DailyClosing', 'AuditLog', 'ManagerSecurity'];
    
    let sqlDump = `-- CarePlus Pharmacy Backup\n-- Date: ${new Date().toLocaleString('en-US')}\n\n`;
    sqlDump += `SET FOREIGN_KEY_CHECKS=0;\n\n`; // لإيقاف فحص الروابط مؤقتاً أثناء الاسترجاع

    for (const table of tables) {
      // 1. جلب هيكل الجدول (Schema)
      const [schemaRows] = await pool.query(`SHOW CREATE TABLE \`${table}\``);
      if (schemaRows.length > 0) {
        sqlDump += `-- --------------------------------------------------------\n`;
        sqlDump += `-- Table structure for \`${table}\`\n`;
        sqlDump += `-- --------------------------------------------------------\n`;
        sqlDump += `DROP TABLE IF EXISTS \`${table}\`;\n`;
        sqlDump += `${schemaRows[0]['Create Table']};\n\n`;
      }

      // 2. جلب بيانات الجدول (Data)
      const [rows] = await pool.query(`SELECT * FROM \`${table}\``);
      if (rows.length > 0) {
        sqlDump += `-- Dumping data for table \`${table}\`\n`;
        
        for (const row of rows) {
          const columns = Object.keys(row).map(c => `\`${c}\``).join(', ');
          
          const values = Object.values(row).map(val => {
            if (val === null) return 'NULL';
            if (typeof val === 'string') {
              // حماية وتنظيف النصوص من علامات التنصيص
              const escaped = val.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
              return `'${escaped}'`;
            }
            if (val instanceof Date) {
              // تحويل التاريخ لصيغة تناسب MySQL
              return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
            }
            if (typeof val === 'object') {
              const escapedJson = JSON.stringify(val).replace(/\\/g, '\\\\').replace(/'/g, "''");
              return `'${escapedJson}'`;
            }
            return val;
          }).join(', ');
          
          sqlDump += `INSERT INTO \`${table}\` (${columns}) VALUES (${values});\n`;
        }
        sqlDump += `\n\n`;
      }
    }

    sqlDump += `SET FOREIGN_KEY_CHECKS=1;\n`; // إعادة تفعيل الروابط


    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `careplus_backup_${timestamp}.sql`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(sqlDump);

  } catch (err) {
    console.error('Backup Error:', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء إنشاء النسخة الاحتياطية' });
  }
});   

// =================== Restore Database ===================

router.post('/restore', verifyToken, authorizeRoles('admin'), upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'الرجاء إرفاق ملف النسخة الاحتياطية' });
    }

    const filePath = req.file.path;
    
    // قراءة محتوى الملف بالكامل
    const sqlDump = fs.readFileSync(filePath, 'utf8');

    // تنفيذ محتوى الملف في قاعدة البيانات
    await pool.query(sqlDump);

    // تنظيف السيرفر بمسح الملف المؤقت
    fs.unlinkSync(filePath);

    res.json({ message: 'تم استرجاع قاعدة البيانات بنجاح' });
  } catch (err) {
    console.error('Restore Error:', err.message);
    
    // تنظيف السيرفر في حالة حدوث خطأ
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({ error: 'حدث خطأ أثناء الاسترجاع. تأكد من أن الملف سليم وصالح.' });
  }
});

module.exports = router;