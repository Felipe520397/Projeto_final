# Catálogo de Filmes — Tom Hanks

Aplicação desenvolvida para a disciplina **ISW055 - Introdução à Computação em Nuvem**, ministrada pelo professor **@siriani**.

## Tecnologias Utilizadas
- **Node.js** com **Express**
- **EJS** para renderização de telas (SSR)
- **MariaDB** para armazenamento dos dados
- **Docker** para containerização
- **TMDB API** para consumo de dados dos filmes

## Arquitetura e Segurança
- Todas as requisições à API externa do TMDB partem estritamente do servidor backend, garantindo que as chaves de API nunca fiquem expostas no cliente.
- Segregação multi-tenant de usuários feita na camada de dados via filtro `usuario_id = ?`.
- Variáveis de ambiente configuradas no container no Portainer.