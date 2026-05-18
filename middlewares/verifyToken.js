const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'careplus_super_secret_key_2026';

const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; 
  if (!token) return res.status(401).json({ error: 'يرجى تسجيل الدخول أولاً' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'جلسة العمل انتهت أو غير صالحة' });
    req.user = user; 
    next(); 
  });
};

const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'غير مسموح لدورك بالقيام بهذا الإجراء' });
    }
    next();
  };
};

module.exports = { verifyToken, authorizeRoles, JWT_SECRET };