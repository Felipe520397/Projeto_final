const Minio = require('minio');
require('dotenv').config();

const BUCKET_NAME = process.env.MINIO_BUCKET || 'perfil-fotos';

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'minio',
  port: parseInt(process.env.MINIO_PORT || '9000', 10),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || 'minioadmin'
});

/**
 * Inicializa o bucket dedicado para fotos de perfil com política de leitura pública
 */
async function initMinioBucket() {
  try {
    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
      await minioClient.makeBucket(BUCKET_NAME, 'us-east-1');
      console.log(`[MinIO] Bucket "${BUCKET_NAME}" criado com sucesso.`);

      // Política de leitura pública para as imagens de perfil
      const publicPolicy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${BUCKET_NAME}/*`]
          }
        ]
      };

      try {
        await minioClient.setBucketPolicy(BUCKET_NAME, JSON.stringify(publicPolicy));
        console.log(`[MinIO] Política de leitura pública aplicada ao bucket "${BUCKET_NAME}".`);
      } catch (polErr) {
        console.warn(`[MinIO] Aviso ao aplicar política de bucket:`, polErr.message);
      }
    } else {
      console.log(`[MinIO] Bucket "${BUCKET_NAME}" já existe e está pronto.`);
    }
  } catch (error) {
    console.warn(`[MinIO] Aviso ao conectar/inicializar MinIO:`, error.message);
  }
}

/**
 * Faz upload do arquivo binário para o MinIO
 */
async function uploadProfilePhoto(fileName, buffer, mimetype) {
  const metaData = {
    'Content-Type': mimetype
  };

  await minioClient.putObject(BUCKET_NAME, fileName, buffer, buffer.length, metaData);
  return fileName;
}

/**
 * Obtém stream de leitura do objeto no MinIO para servir como proxy público
 */
async function getProfilePhotoStream(fileName) {
  return await minioClient.getObject(BUCKET_NAME, fileName);
}

module.exports = {
  minioClient,
  BUCKET_NAME,
  initMinioBucket,
  uploadProfilePhoto,
  getProfilePhotoStream
};
