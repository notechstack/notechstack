/* Configuração de produção das páginas /agentes/fiscal/comecar/ e /agentes/fiscal/conta/ (Decided da tarefa
   agente-fiscal-v2, "Cadastro, checkout e onboarding no site"). A anonKey é a chave pública (anon) do projeto:
   só abre o que as políticas e as funções deixam. A demonstração local serve outro config.js no lugar deste
   (tools/fiscal-demo). whatsappAgente = o número próprio do agente, só do robô (Lucca, 29/10/2026); o
   atendimento continua no número oficial da Nó, 5511939289413. */
window.NOFISCAL_CONFIG = {
  supabaseUrl: 'https://sdeowbqmwkwseyktyemn.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkZW93YnFtd2t3c2V5a3R5ZW1uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NDI2ODQsImV4cCI6MjA5MDIxODY4NH0.q9nQQgagMRhkknHrMunVc3LHwRFaLassKw1xBDzYuZQ',
  funcoesUrl: 'https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1',
  apiBase: '/agentes/fiscal/api',
  whatsappAgente: '5511945146923'
};
