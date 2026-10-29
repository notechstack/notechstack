import { Navigate, Route, Routes } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { ProtectedRoute } from './auth/ProtectedRoute'
import { RoleRoute } from './auth/RoleRoute'
import { ClientDashboardPage } from './client-dashboard/ClientDashboardPage'
import { ClientProjectsPage } from './pages/ClientProjectsPage'
import { AccessPage } from './pages/AccessPage'
import { LoginPage } from './pages/LoginPage'
import { UnauthorizedPage } from './pages/UnauthorizedPage'
const AdminActivityPage = lazy(() => import('./admin-dashboard/AdminDashboardPages').then(m => ({ default: m.AdminActivityPage })))
const AdminProjectDetailPage = lazy(() => import('./admin-dashboard/AdminDashboardPages').then(m => ({ default: m.AdminProjectDetailPage })))
const AdminProjectsPage = lazy(() => import('./admin-dashboard/AdminDashboardPages').then(m => ({ default: m.AdminProjectsPage })))
const SaldosPage = lazy(() => import('./pages/SaldosPage').then(m => ({ default: m.SaldosPage })))
const ArchiveLibraryPage = lazy(() => import('./pages/ArchiveLibraryPage').then(m => ({ default: m.ArchiveLibraryPage })))
const SchedulePage = lazy(() => import('./pages/SchedulePage').then(m => ({ default: m.SchedulePage })))
const MarketingLayout = lazy(() => import('./marketing/MarketingLayout').then(m => ({ default: m.MarketingLayout })))
const OverviewPage = lazy(() => import('./marketing/OverviewPage').then(m => ({ default: m.OverviewPage })))
const CampaignsPage = lazy(() => import('./marketing/CampaignsPage').then(m => ({ default: m.CampaignsPage })))
const CampaignDetailPage = lazy(() => import('./marketing/CampaignDetailPage').then(m => ({ default: m.CampaignDetailPage })))
const NewMetaCampaignPage = lazy(() => import('./marketing/NewMetaCampaignPage').then(m => ({ default: m.NewMetaCampaignPage })))
const NewGoogleCampaignPage = lazy(() => import('./marketing/NewGoogleCampaignPage').then(m => ({ default: m.NewGoogleCampaignPage })))
const CalendarPage = lazy(() => import('./marketing/CalendarPage').then(m => ({ default: m.CalendarPage })))
const LogPage = lazy(() => import('./marketing/LogPage').then(m => ({ default: m.LogPage })))
const AgentPage = lazy(() => import('./marketing/AgentPage').then(m => ({ default: m.AgentPage })))
const LeadsPage = lazy(() => import('./marketing/LeadsPage').then(m => ({ default: m.LeadsPage })))
const ConnectionsPage = lazy(() => import('./marketing/ConnectionsPage').then(m => ({ default: m.ConnectionsPage })))
const EntrarAuditorPage = lazy(() => import('./auditor/EntrarPage').then(m => ({ default: m.EntrarPage })))
const AuditorLayout = lazy(() => import('./auditor/AuditorPages').then(m => ({ default: m.AuditorLayout })))
const AuditorHomePage = lazy(() => import('./auditor/AuditorPages').then(m => ({ default: m.AuditorHomePage })))
const AuditorConexoesPage = lazy(() => import('./auditor/AuditorPages').then(m => ({ default: m.ConexoesPage })))
const AuditorRelatoriosPage = lazy(() => import('./auditor/AuditorPages').then(m => ({ default: m.RelatoriosPage })))
const AuditorRelatorioPage = lazy(() => import('./auditor/AuditorPages').then(m => ({ default: m.RelatorioPage })))
const AuditorContaPage = lazy(() => import('./auditor/AuditorPages').then(m => ({ default: m.ContaPage })))
const AuditorRota = lazy(() => import('./auditor/AuditorRota').then(m => ({ default: m.AuditorRota })))
const AuditorPlanosPage = lazy(() => import('./auditor/PlanosPage').then(m => ({ default: m.PlanosPage })))
const AuditorOperacaoPage = lazy(() => import('./auditor/OperacaoPage').then(m => ({ default: m.OperacaoPage })))
const CentralConversasPage = lazy(() => import('./fiscal/CentralConversasPage').then(m => ({ default: m.CentralConversasPage })))
const MarketingAccessPage = lazy(() => import('./marketing/MarketingAccessPage').then(m => ({ default: m.MarketingAccessPage })))

const AgencyConsolePage = lazy(() => import('./agency/AgencyConsolePage').then(m => ({ default: m.AgencyConsolePage })))
const AgencyManagementPage = lazy(() => import('./agency/AgencyManagementPage').then(m => ({ default: m.AgencyManagementPage })))
const BrandingPreview = import.meta.env.DEV && import.meta.env.VITE_AGENCY_LOCAL_PREVIEW === 'true'
  ? lazy(() => import('./client-dashboard/ClientBrandingPreview')) : null
const AgencyProjectPreview = import.meta.env.DEV && import.meta.env.VITE_AGENCY_LOCAL_PREVIEW === 'true'
  ? lazy(() => import('./agency/AgencyProjectPreview')) : null

export function AppRoutes() {
  return (
    <Suspense fallback={<p role="status">Carregando página…</p>}>
    <Routes>
      {AgencyProjectPreview ? <Route path="/__preview/agencia/projeto" element={<AgencyProjectPreview />} /> : null}
      {BrandingPreview ? <Route path="/__preview/cliente-agencia/:module" element={<Suspense fallback={<p>Carregando prévia…</p>}><BrandingPreview /></Suspense>} /> : null}
      <Route path="/acesso" element={<AccessPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auditor/entrar" element={<EntrarAuditorPage />} />
      {/* Auditor por cliente: o acesso é decidido no servidor (RLS + auditor_eu_*), não pelo papel.
          Sem sessão, vai para /auditor/entrar com o destino guardado (revisão B1). */}
      <Route element={<AuditorRota />}>
        <Route path="/auditor" element={<AuditorLayout />}>
          <Route index element={<AuditorHomePage />} />
          <Route path="conta" element={<AuditorContaPage />} />
          <Route path="planos" element={<AuditorPlanosPage />} />
          <Route path=":clientId/conexoes" element={<AuditorConexoesPage />} />
          <Route path=":clientId/relatorios" element={<AuditorRelatoriosPage />} />
          <Route path=":clientId/relatorios/:relatorioId" element={<AuditorRelatorioPage />} />
        </Route>
      </Route>
      <Route element={<ProtectedRoute />}>
        <Route path="/agencia" element={<AgencyConsolePage />} />
        <Route path="/agencia/:agencyId" element={<AgencyConsolePage />} />
        <Route path="/agencia/:agencyId/projetos/:projectId" element={<AgencyConsolePage />} />
        <Route path="/p/projetos" element={<ClientProjectsPage />} />
        <Route path="/p/:projectId/como-funciona" element={<ClientDashboardPage module="como_funciona" />} />
        <Route path="/p/:projectId/prototipo" element={<ClientDashboardPage module="prototipo" />} />
        <Route path="/p/:projectId/etapas" element={<ClientDashboardPage module="etapas" />} />
        <Route path="/p/:projectId/editor" element={<ClientDashboardPage module="editor" />} />
        <Route path="/p/:projectId/versoes" element={<ClientDashboardPage module="versoes" />} />
        <Route path="/p/:projectId/marca" element={<Navigate to="../como-funciona" replace />} />
        {/* Planner de marketing: Lucca (NO_ADMIN com aal2) e a conta do dot (MARKETING_AGENT). */}
        <Route path="/no/marketing" element={<RoleRoute roles={['NO_ADMIN', 'MARKETING_AGENT']} requireAal2 />}>
          <Route path="acesso" element={<MarketingAccessPage />} />
          <Route element={<MarketingLayout />}>
            <Route index element={<Navigate to="visao-geral" replace />} />
            <Route path="visao-geral" element={<OverviewPage />} />
            <Route path="campanhas" element={<CampaignsPage />} />
            <Route path="campanhas/nova/meta" element={<NewMetaCampaignPage />} />
            <Route path="campanhas/nova/google" element={<NewGoogleCampaignPage />} />
            <Route path="campanhas/:plataforma/:campaignId" element={<CampaignDetailPage />} />
            <Route path="calendario" element={<CalendarPage />} />
            <Route path="registro" element={<LogPage />} />
            <Route path="conexoes" element={<ConnectionsPage />} />
            <Route element={<RoleRoute roles={['NO_ADMIN']} requireAal2 />}>
              <Route path="dot" element={<AgentPage />} />
              <Route path="leads" element={<LeadsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="visao-geral" replace />} />
          </Route>
        </Route>
        <Route path="/no/*" element={<RoleRoute roles={['NO_ADMIN']} requireAal2 />}>
          <Route path="projetos" element={<AdminProjectsPage />} />
          <Route path="agencias" element={<AgencyManagementPage />} />
          <Route path="auditor" element={<AuditorOperacaoPage />} />
          <Route path="fiscal/conversas" element={<CentralConversasPage />} />
          <Route path="projetos/:projectId" element={<AdminProjectDetailPage />} />
          <Route path="atividade" element={<AdminActivityPage />} />
          <Route path="saldos" element={<SaldosPage />} />
          <Route path="biblioteca" element={<ArchiveLibraryPage />} />
          <Route path="cronograma" element={<SchedulePage />} />
        </Route>
      </Route>
      <Route path="/nao-autorizado" element={<UnauthorizedPage />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
    </Suspense>
  )
}
