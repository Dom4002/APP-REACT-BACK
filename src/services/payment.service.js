// 📁 backend/src/services/payment.service.js
 

const axios = require('axios');

const FEDAPAY_API_KEY = process.env.FEDAPAY_API_KEY;
const FEDAPAY_URL = 'https://api.fedapay.com/v1';

const fedapay = axios.create({
  baseURL: FEDAPAY_URL,
  headers: {
    'Authorization': `Bearer ${FEDAPAY_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

// =============================================
// CRÉER UNE TRANSACTION
// =============================================
const createTransaction = async (data) => {
  try {
    // ✅ Construire les métadonnées complètes
    const metadata = {
      user_id: data.userId,
      order_id: data.orderId || null,
      subscription_id: data.subscriptionId || null,
      is_ponctual: data.is_ponctual || false,
      is_visit: data.is_visit || false,
      visit_id: data.visit_id || null,
      type: data.type || (data.is_visit ? 'visit' : (data.is_ponctual ? 'order' : 'subscription')),
      patient_id: data.patient_id || null,
      target_type: data.target_type || 'personal',
      target_name: data.target_name || 'Client',
      order_data: data.orderData || null,
      source: 'sante_plus_services',
      platform: 'web',
    };

    console.log('📦 Métadonnées FedaPay:', JSON.stringify(metadata, null, 2));

    const response = await fedapay.post('/transactions', {
      amount: data.amount,
      currency: 'XOF',
      description: data.description || 'Santé Plus Services',
      callback_url: data.callback_url || `${process.env.CLIENT_URL}/payment/confirm`,
      cancel_url: data.cancel_url || `${process.env.CLIENT_URL}/payment/cancel`,
      customer: {
        email: data.email,
        firstname: data.firstname || 'Client',
        lastname: data.lastname || 'Santé Plus',
        phone_number: data.phone || null,
      },
      metadata: metadata,
    });

    console.log('✅ Transaction FedaPay créée:', response.data?.id);
    return response.data;
  } catch (error) {
    console.error('❌ FedaPay transaction error:', error.response?.data || error.message);
    throw error;
  }
};

// =============================================
// RÉCUPÉRER UNE TRANSACTION
// =============================================
const getTransaction = async (transactionId) => {
  try {
    const response = await fedapay.get(`/transactions/${transactionId}`);
    return response.data;
  } catch (error) {
    console.error('❌ FedaPay get transaction error:', error.response?.data || error.message);
    throw error;
  }
};

// =============================================
// CRÉER UN CLIENT
// =============================================
const createCustomer = async (data) => {
  try {
    const response = await fedapay.post('/customers', {
      email: data.email,
      firstname: data.firstname || 'Client',
      lastname: data.lastname || 'Santé Plus',
      phone_number: data.phone || null,
    });
    return response.data;
  } catch (error) {
    console.error('❌ FedaPay create customer error:', error.response?.data || error.message);
    throw error;
  }
};

// =============================================
// VÉRIFIER LE STATUT D'UNE TRANSACTION
// =============================================
const verifyTransaction = async (transactionId) => {
  try {
    const response = await fedapay.get(`/transactions/${transactionId}`);
    const transaction = response.data;
    
    return {
      id: transaction.id,
      status: transaction.status,
      amount: transaction.amount,
      currency: transaction.currency,
      paid_at: transaction.paid_at || null,
      customer: transaction.customer,
      metadata: transaction.metadata || {},
    };
  } catch (error) {
    console.error('❌ FedaPay verify transaction error:', error.response?.data || error.message);
    throw error;
  }
};

// =============================================
// ANNULER UNE TRANSACTION
// =============================================
const cancelTransaction = async (transactionId) => {
  try {
    const response = await fedapay.post(`/transactions/${transactionId}/cancel`);
    return response.data;
  } catch (error) {
    console.error('❌ FedaPay cancel transaction error:', error.response?.data || error.message);
    throw error;
  }
};

// =============================================
// REMBOURSER UNE TRANSACTION
// =============================================
const refundTransaction = async (transactionId, amount = null) => {
  try {
    const data = amount ? { amount } : {};
    const response = await fedapay.post(`/transactions/${transactionId}/refund`, data);
    return response.data;
  } catch (error) {
    console.error('❌ FedaPay refund transaction error:', error.response?.data || error.message);
    throw error;
  }
};

module.exports = {
  fedapay,
  createTransaction,
  getTransaction,
  createCustomer,
  verifyTransaction,
  cancelTransaction,
  refundTransaction,
};
