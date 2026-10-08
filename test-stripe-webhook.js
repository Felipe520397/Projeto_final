/**
 * Script de Teste / Simulação do Webhook do Stripe
 * Execução: node test-stripe-webhook.js [usuario_id]
 */

const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const PORT = process.env.PORT_HOST || process.env.PORT || 8204;
const WEBHOOK_URL = `http://localhost:${PORT}/webhook/stripe`;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

const usuarioId = process.argv[2] || 1;

console.log(`\n======================================================`);
console.log(`Disparando Webhook de Teste do Stripe`);
console.log(`Destino: ${WEBHOOK_URL}`);
console.log(`Usuário ID Alvo: ${usuarioId}`);
console.log(`======================================================\n`);

const payloadObj = {
  id: 'evt_test_' + Date.now(),
  object: 'event',
  api_version: '2023-10-16',
  created: Math.floor(Date.now() / 1000),
  type: 'checkout.session.completed',
  data: {
    object: {
      id: 'cs_test_' + Date.now(),
      object: 'checkout.session',
      customer: 'cus_simulado_' + Date.now(),
      subscription: 'sub_simulado_' + Date.now(),
      client_reference_id: String(usuarioId),
      metadata: {
        usuario_id: String(usuarioId)
      },
      customer_details: {
        email: 'usuario.teste@exemplo.com'
      },
      payment_status: 'paid',
      status: 'complete'
    }
  }
};

const payloadString = JSON.stringify(payloadObj);
const headers = {
  'Content-Type': 'application/json'
};

// Se houver STRIPE_WEBHOOK_SECRET, gera cabeçalho de assinatura stripe-signature HMAC-SHA256 válido
if (WEBHOOK_SECRET) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signaturePayload = `${timestamp}.${payloadString}`;
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signaturePayload).digest('hex');
  headers['stripe-signature'] = `t=${timestamp},v1=${hmac}`;
  console.log(`[Segurança] Assinatura HMAC gerada com STRIPE_WEBHOOK_SECRET.`);
} else {
  console.log(`[Aviso] STRIPE_WEBHOOK_SECRET não definida. Enviando payload direto.`);
}

async function run() {
  try {
    const res = await axios.post(WEBHOOK_URL, payloadString, { headers });
    console.log(`✅ Sucesso! Resposta do Servidor:`, res.status, res.data);
    console.log(`🎉 O usuário ID ${usuarioId} foi promovido a PREMIUM pelo webhook!`);
  } catch (err) {
    console.error(`❌ Erro ao enviar webhook:`, err.response?.status, err.response?.data || err.message);
  }
}

run();

