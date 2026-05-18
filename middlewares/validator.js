const Joi = require('joi');

const schemas = {
  user: Joi.object({
    username: Joi.string().min(3).required(),
    fullName: Joi.string().required(),
    email: Joi.string().email().allow('', null),
    phone: Joi.string().pattern(/^[0-9]+$/),
    role: Joi.string().valid('admin', 'pharmacist', 'delivery', 'cashier').required(), 
    password: Joi.string().min(6).required(),
    expectedDays: Joi.number().integer().min(1).max(31).optional(),
    dailyHours: Joi.number().integer().min(1).max(24).optional()
  }),

  updateUser: Joi.object({
    username: Joi.string().min(3).required(),
    fullName: Joi.string().required(),
    email: Joi.string().email().allow('', null),
    phone: Joi.string().pattern(/^[0-9]+$/),
    role: Joi.string().valid('admin', 'pharmacist', 'delivery', 'cashier').required(),
    password: Joi.string().min(6).optional().allow('', null), 
    expectedDays: Joi.number().integer().min(1).max(31).optional(),
    dailyHours: Joi.number().integer().min(1).max(24).optional(),
    active: Joi.number().valid(0, 1).optional()
  }),

  medicine: Joi.object({
    name: Joi.string().required(),
    barcode: Joi.string().required(),
    expiryDate: Joi.date().iso().required(),
    quantity: Joi.number().min(0).required(),
    purchasePrice: Joi.number().min(0).required(),
    sellingPrice: Joi.number().min(0).required(),
    requiresPrescription: Joi.boolean().optional(),
    supplierId: Joi.string().optional().allow('', null),
    pillCount: Joi.number().integer().min(0).optional().allow(null), 
    stripCount: Joi.number().integer().min(0).optional().allow(null),
    manufacturer: Joi.string().optional().allow('', null), 
    genericName: Joi.string().optional().allow('', null), 
    medicineForm: Joi.string().optional().allow('', null) 
  }),

  login: Joi.object({
    username: Joi.string().required().messages({
      'string.empty': 'الرجاء إدخال اسم المستخدم',
      'any.required': 'الرجاء إدخال اسم المستخدم'
    }),
    password: Joi.string().required().messages({
      'string.empty': 'الرجاء إدخال كلمة المرور',
      'any.required': 'الرجاء إدخال كلمة المرور'
    })
  }),

  supplier: Joi.object({
    name: Joi.string().required(),
    phones: Joi.array().items(Joi.string()).optional(),
    address: Joi.string().optional().allow('', null)
  }),

  sale: Joi.object({
    paymentMethod: Joi.string().valid('cash', 'card', 'wallet', 'insurance').required(),
    items: Joi.array().items(
      Joi.object({
        medicineId: Joi.string().required(),
        qty: Joi.number().positive().required(), 
        quantityType: Joi.string().valid('box', 'strip', 'pill').required()
      })
    ).min(1).required()
  }),

  returnSale: Joi.object({
    saleId: Joi.string().required(),
    returnedItems: Joi.array().items(
      Joi.object({
        saleItemId: Joi.string().required(), 
        qtyToReturn: Joi.number().positive().required() 
      })
    ).min(1).required()
  })
};

const validateRequest = (schema) => {
  return (req, res, next) => {
    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }
    next();
  };
};

module.exports = { schemas, validateRequest };