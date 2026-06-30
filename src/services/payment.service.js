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
    const response = await fedapay.post('/transactions', {
      amount: data.amount,
      currency: 'XOF',
      description: data.description,
      callback_url: data.callback_url || `${process.env.CLIENT_URL}/payment/confirm`,
      cancel_url: data.cancel_url || `${process.env.CLIENT_URL}/payment/cancel`,
      customer: {
        email: data.email,
        firstname: data.firstname,
        lastname: data.lastname,
        phone_number: data.phone,
      },
      meta: {
        user_id: data.userId,
        order_id: data.orderId,
        subscription_id: data.subscriptionId,

        // 🔥 FIX
        is_ponctual: true,
        order_data: data.orderData,
      },
    });

    return response.data;
  } catch (error) {
    console.error('FedaPay transaction error:', error.response?.data || error.message);
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
    console.error('FedaPay get transaction error:', error.response?.data || error.message);
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
      firstname: data.firstname,
      lastname: data.lastname,
      phone_number: data.phone,
    });
    return response.data;
  } catch (error) {
    console.error('FedaPay create customer error:', error.response?.data || error.message);
    throw error;
  }
};

module.exports = {
  fedapay,
  createTransaction,
  getTransaction,
  createCustomer,
};