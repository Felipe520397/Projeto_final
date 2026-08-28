CREATE TABLE IF NOT EXISTS usuarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    senha VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'usuario'
);

CREATE TABLE IF NOT EXISTS reset_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token VARCHAR(255) UNIQUE NOT NULL,
    usuario_id INT NOT NULL,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    expira_em DATETIME NOT NULL,
    usado BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- Insere usuário inicial para testes
INSERT INTO usuarios (nome, email, senha, role) 
VALUES ('Usuario Teste', 'epilef1357908642@gmail.com', '$2b$10$EpRnTzVlqHNP0.fKbX23.e15G6kP2I1.X3sN4a/xH8P5M.W5f7oKe', 'usuario')
ON DUPLICATE KEY UPDATE id=id;