import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/auth-context'
import { LoadingScreen } from '../components/LoadingScreen'

// /auditor/* sem sessão vai para a entrada do auditor (link mágico), não para o /login com senha, guardando o
// caminho e a query para voltar depois (revisão B1: links do e-mail do relatório, Assinar, Sair).
export function AuditorRota() {
  const { loading, session } = useAuth()
  const location = useLocation()
  if (loading) return <LoadingScreen />
  if (!session) {
    const volta = `${location.pathname}${location.search}`
    return <Navigate to={`/auditor/entrar?volta=${encodeURIComponent(volta)}`} replace />
  }
  return <Outlet />
}
