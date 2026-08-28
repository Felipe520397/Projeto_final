const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3000';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/', (req, res) => res.render('index'));
app.get('/login', (req, res) => res.render('login'));
app.get('/cadastro', (req, res) => res.render('cadastro'));
app.get('/esqueci-senha', (req, res) => res.render('esqueci-senha'));

app.get('/redefinir-senha', (req, res) => {
  res.render('redefinir-senha', { token: req.query.token });
});

app.post('/login', async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/login`, req.body);
    return res.json(response.data);
  } catch (error) {
    return res.status(error.response?.status || 500).json(error.response?.data || { error: error.message });
  }
});

app.post('/cadastro', async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/cadastro`, req.body);
    return res.json(response.data);
  } catch (error) {
    return res.status(error.response?.status || 500).json(error.response?.data || { error: error.message });
  }
});

app.post('/esqueci-senha', async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/esqueci-senha`, { email: req.body.email });
    return res.json(response.data);
  } catch (error) {
    return res.status(error.response?.status || 500).json(error.response?.data || { error: error.message });
  }
});

app.post('/redefinir-senha', async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/redefinir-senha`, req.body);
    return res.json(response.data);
  } catch (error) {
    return res.status(error.response?.status || 500).json(error.response?.data || { error: error.message });
  }
});

app.listen(PORT, () => console.log(`Catálogo rodando na porta ${PORT}`));