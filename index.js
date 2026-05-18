
require('dotenv').config();

// مؤقت للـ debugging
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_NAME:', process.env.DB_NAME);
console.log('DB_PORT:', process.env.DB_PORT);
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

// ================= SECURITY MIDDLEWARES =================
app.set('trust proxy', 1); // ← قبل أي middleware
app.use(helmet()); 
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5000' }));
//app.use(cors({ origin: '*' })); 
app.use(express.json());

// ================= استيراد الـ Routes =================
const authRoutes = require('./routes/auth');
const medicineRoutes = require('./routes/medicines');
const userRoutes = require('./routes/users');
const supplierRoutes = require('./routes/suppliers');
const salesRoutes = require('./routes/sales');
const systemRoutes = require('./routes/system');
const attendanceRoutes = require('./routes/attendance');

// ================= تشغيل الـ Routes =================
app.use('/api', authRoutes); 
app.use('/api/medicines', medicineRoutes);
app.use('/api/users', userRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api', systemRoutes); 
app.use('/api/attendance', attendanceRoutes);

// ================= SERVER =================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Secure Server Running with JWT on Port ${PORT}`));