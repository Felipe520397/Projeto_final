const express = require('express');
const cors = require('cors');
require('dotenv').config();

const redis = require('./redisClient');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const STREAM_KEY = process.env.REDIS_STREAM_KEY || 'audit_stream';

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'log-service',
    redis_status: redis.status
  });
});

/**
 * ROTA: Registrar evento de auditoria no Redis Streams
 * POST /logs
 * Body: { usuario_id, usuario_nome, usuario_email, acao, detalhes, ip, timestamp, servico_origem }
 */
app.post('/logs', async (req, res) => {
  try {
    const {
      usuario_id,
      usuario_nome,
      usuario_email,
      acao,
      detalhes,
      ip,
      timestamp,
      servico_origem
    } = req.body;

    if (!acao) {
      return res.status(400).json({ success: false, error: 'O campo "acao" é obrigatório para registrar o log.' });
    }

    const logTimestamp = timestamp || new Date().toISOString();
    const detalhesStr = typeof detalhes === 'object' ? JSON.stringify(detalhes) : String(detalhes || '');
    const userIp = ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

    // Grava no Redis Stream usando XADD com limite máximo aproximado de 5000 eventos (MAXLEN ~)
    const streamId = await redis.xadd(
      STREAM_KEY,
      'MAXLEN',
      '~',
      '5000',
      '*',
      'usuario_id', String(usuario_id !== undefined && usuario_id !== null ? usuario_id : 'anonimo'),
      'usuario_nome', String(usuario_nome || 'Anônimo'),
      'usuario_email', String(usuario_email || ''),
      'acao', String(acao),
      'detalhes', detalhesStr,
      'ip', String(userIp),
      'timestamp', String(logTimestamp),
      'servico_origem', String(servico_origem || 'aplicacao')
    );

    console.log(`[Log-Service] Evento registrado [${acao}] por ${usuario_nome || 'Anônimo'} (ID: ${streamId})`);

    return res.status(201).json({
      success: true,
      message: 'Log de auditoria registrado com sucesso.',
      id: streamId
    });
  } catch (error) {
    console.error('[Log-Service] Erro ao gravar log no Redis Stream:', error.message);
    return res.status(500).json({ success: false, error: 'Erro interno ao gravar log de auditoria.' });
  }
});

/**
 * ROTA: Consultar eventos de auditoria (ordem decrescente - mais recentes primeiro)
 * GET /logs
 * Query: limit (default: 100), acao, usuario_id
 */
app.get('/logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);

    // Consulta os eventos do stream do mais recente para o mais antigo (XREVRANGE + - COUNT <limit>)
    const rawEntries = await redis.xrevrange(STREAM_KEY, '+', '-', 'COUNT', limit);

    const logs = rawEntries.map(([streamId, fields]) => {
      const entry = { stream_id: streamId };
      for (let i = 0; i < fields.length; i += 2) {
        entry[fields[i]] = fields[i + 1];
      }
      try {
        if (entry.detalhes && (entry.detalhes.startsWith('{') || entry.detalhes.startsWith('['))) {
          entry.detalhes = JSON.parse(entry.detalhes);
        }
      } catch {
        // Mantém como string caso não seja JSON
      }
      return entry;
    });

    // Filtros opcionais em memória
    let filteredLogs = logs;
    if (req.query.acao) {
      filteredLogs = filteredLogs.filter(l => l.acao.toLowerCase().includes(req.query.acao.toLowerCase()));
    }
    if (req.query.usuario_id) {
      filteredLogs = filteredLogs.filter(l => String(l.usuario_id) === String(req.query.usuario_id));
    }

    return res.json({
      success: true,
      total: filteredLogs.length,
      logs: filteredLogs
    });
  } catch (error) {
    console.error('[Log-Service] Erro ao consultar logs do Redis Stream:', error.message);
    return res.status(500).json({ success: false, error: 'Erro interno ao consultar logs de auditoria.' });
  }
});

const PORT = process.env.INTERNAL_PORT || 3002;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`>>> [LOG-SERVICE] RODANDO INTERNAMENTE NA PORTA ${PORT} <<<`);
});
