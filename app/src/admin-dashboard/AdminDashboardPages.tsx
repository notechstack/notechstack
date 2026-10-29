import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useParams } from "react-router-dom";
import {
  activateBrandModule,
  activateDashboard,
  archiveProject,
  associateEditorChecklistVersion,
  convertProject,
  filterActivityEvents,
  filterProjects,
  listAdminActivity,
  listAdminEditorExports,
  listAdminKanbanItems,
  listAdminProjectVersions,
  listAdminProjects,
  loadAdminProject,
  ingestEditorExport,
  publishProjectVersion,
  saveCommercialTerms,
  saveKanbanItem,
  sortKanbanItems,
  transitionLead,
  transitionProjectStatus,
  type ActivityEvent,
  type ActivityView,
  type ActivityKanbanItem,
  type AdminEditorExport,
  type AdminProjectVersion,
  type CommercialTerms,
  type KanbanItem,
  type ProjectCard,
  type ProjectDetail,
  type ProjectFilters,
  type ProjectStatus,
  type TierKey,
} from "./admin-dashboard-service";

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-vermelho bg-vermelho-tint p-8 text-center">
      <h2 className="text-xl font-bold">Não foi possível carregar.</h2>
      <p className="mt-2 text-sm text-cinza">
        Confira a conexão e tente novamente.
      </p>
      <button
        className="mt-5 rounded-xl bg-tinta px-4 py-2 text-sm font-semibold text-white"
        onClick={onRetry}
        type="button"
      >
        Tentar de novo
      </button>
    </div>
  );
}

function EditorExportsControl({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const [exports, setExports] = useState<AdminEditorExport[]>([]);
  const [versions, setVersions] = useState<AdminProjectVersion[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [refreshToken, setRefreshToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([listAdminEditorExports(project.id), listAdminProjectVersions(project.id)])
      .then(([nextExports, nextVersions]) => {
        if (active) { setExports(nextExports); setVersions(nextVersions); }
      })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project.id, refreshToken]);

  async function ingest(item: AdminEditorExport) {
    setBusy(item.id); setMessage("");
    try {
      const result = await ingestEditorExport(item.id);
      setMessage(`${result.items ?? item.checklist.items.length} grupo(s) encaminhado(s) ao Kanban.`);
      setRefreshToken((value) => value + 1); onChanged();
    } catch { setMessage("Não foi possível ingerir o pacote. O projeto deve estar em revisão do cliente."); }
    finally { setBusy(null); }
  }

  async function associate(item: AdminEditorExport) {
    const versionId = targets[item.checklist.id];
    if (!versionId) { setMessage("Selecione a versão que incorporou este checklist."); return; }
    setBusy(item.checklist.id); setMessage("");
    try {
      await associateEditorChecklistVersion(item.checklist.id, versionId);
      setMessage("Checklist associado à versão e liberado no histórico do cliente.");
      setRefreshToken((value) => value + 1);
    } catch { setMessage("Não foi possível associar: escolha uma versão publicada depois da versão-base."); }
    finally { setBusy(null); }
  }

  return <section className="rounded-2xl border border-borda bg-white p-5">
    <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-azul">Exports do Editor</h2>
    <p className="mt-2 text-sm text-cinza">Checklist agrupado por tela e componente, com ingestão idempotente no Kanban.</p>
    {loading ? <p className="mt-5 text-sm text-cinza" role="status">Carregando exports…</p> : null}
    {error ? <button type="button" className="mt-5 rounded-xl bg-tinta px-4 py-2 text-sm text-white" onClick={() => { setLoading(true); setError(false); setRefreshToken((value) => value + 1); }}>Tentar de novo</button> : null}
    {!loading && !error && exports.length === 0 ? <p className="mt-5 rounded-xl border border-dashed border-borda p-5 text-sm text-cinza">Nenhum pacote recebido.</p> : null}
    <div className="mt-5 space-y-4">{exports.map((item) => {
      const base = versions.find((version) => version.id === item.baseVersionId);
      const targetsForItem = versions.filter((version) => version.id !== item.baseVersionId && (!base || new Date(version.published_at) >= new Date(base.published_at)));
      return <article className="rounded-xl border border-borda p-4" key={item.id}>
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-bold">Base {item.baseVersionLabel}</h3><p className="text-xs text-cinza">Enviado em {new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(item.createdAt))}</p><p className="font-mono text-xs text-cinza">SHA-256 {item.contentSha256.slice(0, 12)}…</p></div><div className="flex gap-2">{item.conflict ? <span className="rounded-full bg-ambar-tint px-3 py-1 text-xs font-semibold">Conflito de base</span> : null}<span className="rounded-full bg-osso px-3 py-1 text-xs font-semibold">{item.checklist.status}</span></div></div>
        <div className="mt-4 space-y-3">{item.checklist.items.map((group) => <div className="rounded-lg bg-osso p-3" key={`${group.screen}:${group.component}`}><p className="font-semibold">{group.screen} / {group.label ?? group.component}</p>{group.label ? <p className="break-all font-mono text-[0.625rem] text-cinza">{group.component}</p> : null}{group.changes.map((change, index) => <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2" key={index}><pre className="overflow-auto rounded bg-white p-2">Antes: {JSON.stringify(change.before, null, 2)}</pre><pre className="overflow-auto rounded bg-white p-2">Depois: {JSON.stringify(change.after, null, 2)}</pre>{typeof change.after.logo === "string" && change.after.logo ? <><ExportImage label="Imagem antes" url={change.before.logo} /><ExportImage label="Imagem enviada" url={change.after.logo} /></> : null}</div>)}</div>)}</div>
        {!item.filesReadyAt ? <p className="mt-3 text-sm text-cinza">Aguardando os quatro arquivos do pacote.</p> : null}
        {item.checklist.status === "recebido" ? <button type="button" disabled={busy !== null || !item.filesReadyAt || project.projectStatus !== "EM_REVISAO_CLIENTE"} className="mt-4 rounded-xl bg-tinta px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void ingest(item)}>Ingerir no Kanban</button> : null}
        {item.checklist.status === "ingerido" && !item.checklist.versionId ? <div className="mt-4 flex flex-wrap gap-2"><label className="min-w-56 flex-1 text-sm"><span className="sr-only">Versão de destino</span><select aria-label={`Versão de destino para ${item.baseVersionLabel}`} className="w-full rounded-xl border border-borda px-3 py-2" value={targets[item.checklist.id] ?? ""} onChange={(event) => setTargets({ ...targets, [item.checklist.id]: event.target.value })}><option value="">Associar à versão…</option>{targetsForItem.map((version) => <option key={version.id} value={version.id}>{version.label}</option>)}</select></label><button type="button" disabled={busy !== null} className="rounded-xl border border-tinta px-4 py-2 text-sm font-semibold" onClick={() => void associate(item)}>Associar checklist</button></div> : null}
        {item.checklist.versionLabel ? <p className="mt-4 text-sm font-semibold text-verde">Incorporado em {item.checklist.versionLabel}</p> : null}
      </article>;
    })}</div>
    {message ? <p className="mt-4 text-sm" role="status">{message}</p> : null}
  </section>;
}

// Only http(s) links render: export values come from the client.
function ExportImage({ label, url }: { label: string; url: unknown }) {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return <p className="text-cinza">{label}: sem arquivo</p>;
  return <a className="block" href={url} target="_blank" rel="noreferrer"><span className="text-cinza">{label}</span><img className="mt-1 max-h-40 w-full rounded border border-borda object-cover" src={url} alt={label} loading="lazy" /></a>;
}

function EmptyState({
  filtered = false,
  children,
}: {
  filtered?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-borda bg-white p-10 text-center text-cinza">
      <span className="mx-auto mb-4 block h-3 w-3 rounded-full bg-ambar" />
      <p>{children}</p>
      {filtered ? (
        <p className="mt-2 text-sm">Ajuste os filtros para ampliar a busca.</p>
      ) : null}
    </div>
  );
}

function AdminShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-osso text-tinta">
      <img
        className="h-1.5 w-full object-cover"
        src="/barra-topo-4-cores.svg"
        alt=""
      />
      <div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-8 lg:px-12 lg:py-9">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-borda pb-6">
          <Link to="/no/projetos">
            <img
              className="h-auto w-40 sm:w-52"
              src="/no-tech-stack-tinta-ponto-ambar.svg"
              alt="nó tech stack"
            />
          </Link>
          <div className="text-right">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-cinza">
              Operação Nó
            </p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-[-0.04em]">
              {title}
            </h1>
          </div>
        </header>
        {children}
      </div>
    </main>
  );
}

const STATUS_LABELS: Record<string, string> = {
  FORMULARIO_PREENCHIDO: "Formulário preenchido",
  PAGAMENTO_PENDENTE: "Pagamento pendente",
  ROADMAP_PAGO: "Roadmap pago",
  REFERENCIAS_PENDENTES: "Referências pendentes",
  EM_PRODUCAO: "Em produção",
  DASHBOARD_LIBERADO: "Dashboard liberado",
  JANELA_DE_DECISAO: "Janela de decisão",
  CONVERTIDO: "Convertido",
  NAO_CONVERTIDO: "Não convertido",
  AGENDADO: "Agendado",
  V1_EM_DESENVOLVIMENTO: "V1 em desenvolvimento",
  V1_PUBLICADA: "V1 publicada",
  EM_REVISAO_CLIENTE: "Em revisão pelo cliente",
  ALTERACOES_RECEBIDAS: "Alterações recebidas",
  V2_EM_DESENVOLVIMENTO: "V2 em desenvolvimento",
  V2_PUBLICADA: "V2 publicada",
  V3_GO_LIVE: "V3 / Go-live",
  CONCLUIDO: "Concluído",
  ARQUIVADO: "Arquivado",
};
const TIER_LABELS: Record<string, string> = {
  essencial: "Essencial",
  basico: "Básico",
  completo: "Completo",
};
const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

function ProjectCardView({ project }: { project: ProjectCard }) {
  return (
    <Link
      to={`/no/projetos/${encodeURIComponent(project.id)}`}
      className="group rounded-2xl border border-borda bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:border-azul focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azul"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-azul">
            {project.niche || "Nicho não informado"}
          </p>
          <h2 className="mt-2 text-xl font-bold group-hover:text-azul">
            {project.clientName}
          </h2>
          <p className="mt-1 text-sm text-cinza">{project.name}</p>
        </div>
        <span className="rounded-full bg-azul-tint px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.08em]">
          {project.tier ? TIER_LABELS[project.tier] : "Sem tier"}
        </span>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-cinza">Estado</dt>
          <dd className="mt-1 font-semibold">
            {STATUS_LABELS[project.projectStatus ?? project.leadStatus] ??
              project.projectStatus ??
              project.leadStatus}
          </dd>
        </div>
        <div>
          <dt className="text-cinza">Próxima data</dt>
          <dd className="mt-1 font-semibold">
            {project.nextScheduledDate ?? "—"}
          </dd>
        </div>
      </dl>
    </Link>
  );
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-cinza">{label}</span>
      <select
        aria-label={label}
        className="w-full rounded-xl border border-borda bg-white px-3 py-2.5"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Todos</option>
        {children}
      </select>
    </label>
  );
}

export function AdminProjectsPage() {
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [filters, setFilters] = useState<ProjectFilters>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const reload = () => {
    setLoading(true);
    setError(false);
    void listAdminProjects()
      .then((value) => {
        setProjects(value);
        setLoaded(true);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    let active = true;
    void listAdminProjects()
      .then((value) => {
        if (active) {
          setProjects(value);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const filtered = useMemo(
    () => filterProjects(projects, filters),
    [projects, filters],
  );
  const setFilter = (key: keyof ProjectFilters, value: string) =>
    setFilters((current) => ({ ...current, [key]: value || undefined }));
  const niches = [
    ...new Set(
      projects
        .map((project) => project.niche)
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const paymentStatuses = [
    ...new Set(
      projects.map((project) => project.paymentStatus ?? "sem_registro"),
    ),
  ].sort((a, b) => a.localeCompare(b, "pt-BR"));
  return (
    <AdminShell title="Projetos">
      <section className="py-8 lg:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.14em] text-azul">
              Visão operacional
            </p>
            <h2 className="mt-2 text-4xl font-extrabold tracking-[-0.05em]">
              Todos os projetos.
            </h2>
          </div>
          <div className="flex flex-wrap gap-3">
          <Link to="/no/marketing" className="rounded-xl border border-borda bg-white px-4 py-2.5 text-sm font-semibold hover:border-azul">Marketing</Link>
          <Link to="/no/agencias" className="rounded-xl border border-borda bg-white px-4 py-2.5 text-sm font-semibold hover:border-azul">Agências</Link>
          <Link to="/no/fiscal/conversas" className="rounded-xl border border-borda bg-white px-4 py-2.5 text-sm font-semibold hover:border-azul">Conversas do Fiscal</Link>
          <Link
            to="/no/atividade"
            className="rounded-xl border border-borda bg-white px-4 py-2.5 text-sm font-semibold hover:border-azul"
          >
            Ver atividade
          </Link>
          </div>
        </div>
        <div className="mt-7 grid gap-3 rounded-2xl border border-borda bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-sm sm:col-span-2">
            <span className="mb-1 block text-cinza">
              Buscar cliente, empresa ou projeto
            </span>
            <input
              aria-label="Buscar projetos"
              className="w-full rounded-xl border border-borda px-3 py-2.5"
              value={filters.search ?? ""}
              onChange={(event) => setFilter("search", event.target.value)}
            />
          </label>
          <SelectField
            label="Nicho"
            value={filters.niche ?? ""}
            onChange={(value) => setFilter("niche", value)}
          >
            {niches.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Estado"
            value={filters.state ?? ""}
            onChange={(value) => setFilter("state", value)}
          >
            {Object.entries(STATUS_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Tier"
            value={filters.tier ?? ""}
            onChange={(value) => setFilter("tier", value)}
          >
            {Object.entries(TIER_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Prazo"
            value={filters.deadline ?? ""}
            onChange={(value) => setFilter("deadline", value)}
          >
            <option value="atrasado">Atrasado</option>
            <option value="hoje">Hoje</option>
            <option value="proximos_7_dias">Próximos 7 dias</option>
            <option value="sem_data">Sem data</option>
          </SelectField>
          <SelectField
            label="Pagamento"
            value={filters.paymentStatus ?? ""}
            onChange={(value) => setFilter("paymentStatus", value)}
          >
            {paymentStatuses.map((value) => (
              <option key={value} value={value}>
                {value === "sem_registro" ? "Sem registro" : value}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Conversão"
            value={filters.conversion ?? ""}
            onChange={(value) => setFilter("conversion", value)}
          >
            <option value="convertido">Convertido</option>
            <option value="nao_convertido">Não convertido</option>
          </SelectField>
          <SelectField
            label="Situação"
            value={filters.lifecycle ?? ""}
            onChange={(value) => setFilter("lifecycle", value)}
          >
            <option value="ativo">Ativo</option>
            <option value="concluido">Concluído</option>
            <option value="arquivado">Arquivado</option>
          </SelectField>
        </div>
        {loading ? (
          <div className="py-16 text-center text-cinza" role="status">
            Carregando projetos…
          </div>
        ) : error ? (
          <div className="mt-7">
            <ErrorState onRetry={reload} />
          </div>
        ) : !loaded || projects.length === 0 ? (
          <div className="mt-7">
            <EmptyState>Nenhum projeto cadastrado ainda.</EmptyState>
          </div>
        ) : filtered.length === 0 ? (
          <div className="mt-7">
            <EmptyState filtered>
              Nenhum projeto para os filtros selecionados.
            </EmptyState>
          </div>
        ) : (
          <div className="mt-7 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((project) => (
              <ProjectCardView key={project.id} project={project} />
            ))}
          </div>
        )}
      </section>
    </AdminShell>
  );
}

function DataGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-borda bg-white p-5">
      <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-azul">
        {title}
      </h2>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}
function DataField({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <dt className="text-xs text-cinza">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium">
        {value == null || value === ""
          ? "—"
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value)}
      </dd>
    </div>
  );
}

function CommercialForm({
  project,
  onSaved,
}: {
  project: ProjectDetail;
  onSaved: (terms: CommercialTerms) => void;
}) {
  const terms = project.commercialTerms;
  const [form, setForm] = useState({
    tier: terms?.tier ?? ("essencial" as TierKey),
    amount_cents: terms?.amount_cents ?? 0,
    payment_method: terms?.payment_method ?? "",
    installments: terms?.installments ?? 1,
    deadline_days: terms?.deadline_days ?? 0,
    starts_on: terms?.starts_on ?? "",
    financial_status: terms?.financial_status ?? "",
    notes: terms?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const saved = await saveCommercialTerms(project.id, form);
      onSaved(saved);
      setMessage("Salvo e registrado na atividade.");
    } catch {
      setMessage("Não foi possível salvar. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-borda bg-white p-5"
    >
      <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-azul">
        Comercial
      </h2>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-cinza">Tier</span>
          <select
            className="w-full rounded-xl border border-borda px-3 py-2.5"
            value={form.tier}
            onChange={(e) =>
              setForm({ ...form, tier: e.target.value as TierKey })
            }
          >
            <option value="essencial">Essencial</option>
            <option value="basico">Básico</option>
            <option value="completo">Completo</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-cinza">Valor (centavos)</span>
          <input
            className="w-full rounded-xl border border-borda px-3 py-2.5"
            type="number"
            min="0"
            value={form.amount_cents}
            onChange={(e) =>
              setForm({ ...form, amount_cents: Number(e.target.value) })
            }
          />
          <span
            aria-label="Valor formatado"
            className="mt-1 block font-mono text-xs text-cinza"
          >
            {BRL.format(form.amount_cents / 100)}
          </span>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-cinza">Forma de pagamento</span>
          <input
            required
            className="w-full rounded-xl border border-borda px-3 py-2.5"
            value={form.payment_method}
            onChange={(e) =>
              setForm({ ...form, payment_method: e.target.value })
            }
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-cinza">Parcelas</span>
          <input
            required
            className="w-full rounded-xl border border-borda px-3 py-2.5"
            type="number"
            min="1"
            value={form.installments}
            onChange={(e) =>
              setForm({ ...form, installments: Number(e.target.value) })
            }
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-cinza">Prazo (dias)</span>
          <input
            required
            className="w-full rounded-xl border border-borda px-3 py-2.5"
            type="number"
            min="1"
            value={form.deadline_days}
            onChange={(e) =>
              setForm({ ...form, deadline_days: Number(e.target.value) })
            }
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-cinza">Início</span>
          <input
            className="w-full rounded-xl border border-borda px-3 py-2.5"
            type="date"
            value={form.starts_on}
            onChange={(e) => setForm({ ...form, starts_on: e.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-cinza">Status financeiro</span>
          <input
            className="w-full rounded-xl border border-borda px-3 py-2.5"
            value={form.financial_status}
            onChange={(e) =>
              setForm({ ...form, financial_status: e.target.value })
            }
          />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-cinza">Observações comerciais</span>
          <textarea
            className="min-h-24 w-full rounded-xl border border-borda px-3 py-2.5"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          disabled={saving}
          className="rounded-xl bg-tinta px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          type="submit"
        >
          {saving ? "Salvando…" : "Salvar comercial"}
        </button>
        {message ? (
          <span className="text-sm text-cinza" role="status">
            {message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function VersionControls({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const status = project.projectStatus;
  const defaults =
    status === "V2_EM_DESENVOLVIMENTO"
      ? { label: "V2", macro: "V2" as const }
      : status === "V2_PUBLICADA"
        ? { label: "V3", macro: "V3" as const }
        : { label: "V1", macro: "V1" as const };
  const [label, setLabel] = useState(defaults.label);
  const [macro, setMacro] = useState<"V1" | "V2" | "V3">(defaults.macro);
  const [changelog, setChangelog] = useState("");
  const [buildReference, setBuildReference] = useState("");
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const canPublish =
    status === "V1_EM_DESENVOLVIMENTO" ||
    status === "V1_PUBLICADA" ||
    status === "EM_REVISAO_CLIENTE" ||
    status === "ALTERACOES_RECEBIDAS" ||
    status === "V2_EM_DESENVOLVIMENTO" ||
    status === "V2_PUBLICADA";
  const nextStatus =
    status === "AGENDADO"
      ? "V1_EM_DESENVOLVIMENTO"
      : status === "V1_PUBLICADA"
        ? "EM_REVISAO_CLIENTE"
        : status === "EM_REVISAO_CLIENTE"
          ? "ALTERACOES_RECEBIDAS"
          : status === "ALTERACOES_RECEBIDAS"
            ? "V2_EM_DESENVOLVIMENTO"
            : null;
  async function publish() {
    setBusy(true);
    setMessage("");
    try {
      await publishProjectVersion({
        projectId: project.id,
        label,
        macro,
        changelog,
        buildReference,
      });
      setConfirmPublish(false);
      setMessage("Versão publicada e registrada na atividade.");
      onChanged();
    } catch {
      setMessage("Não foi possível publicar. Confira o estado e os campos.");
    } finally {
      setBusy(false);
    }
  }
  async function transition(target: ProjectStatus) {
    setBusy(true);
    setMessage("");
    try {
      await transitionProjectStatus(project.id, target);
      setConfirmComplete(false);
      onChanged();
    } catch {
      setMessage("Não foi possível mudar o estado do projeto.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-2xl border border-borda bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-azul">
            Versões e entregas
          </h2>
          <p className="mt-2 text-sm text-cinza">
            Estado atual: {STATUS_LABELS[status ?? ""] ?? status ?? "—"}
          </p>
        </div>
        {nextStatus ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void transition(nextStatus)}
            className="rounded-xl border border-borda px-3 py-2 text-sm font-semibold"
          >
            Avançar para {STATUS_LABELS[nextStatus]}
          </button>
        ) : null}
        {status === "V3_GO_LIVE" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmComplete(true)}
            className="rounded-xl bg-verde px-3 py-2 text-sm font-semibold text-white"
          >
            Concluir projeto
          </button>
        ) : null}
      </div>
      {canPublish ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-cinza">Rótulo</span>
            <input
              className="w-full rounded-xl border border-borda px-3 py-2"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-cinza">Marco</span>
            <select
              className="w-full rounded-xl border border-borda px-3 py-2"
              value={macro}
              onChange={(event) =>
                setMacro(event.target.value as "V1" | "V2" | "V3")
              }
            >
              <option value="V1">V1</option>
              <option value="V2">V2</option>
              <option value="V3">V3</option>
            </select>
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-cinza">Changelog</span>
            <textarea
              className="min-h-20 w-full rounded-xl border border-borda px-3 py-2"
              value={changelog}
              onChange={(event) => setChangelog(event.target.value)}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-cinza">Referência da build</span>
            <input
              className="w-full rounded-xl border border-borda px-3 py-2"
              value={buildReference}
              onChange={(event) => setBuildReference(event.target.value)}
            />
          </label>
        </div>
      ) : null}
      {canPublish && !confirmPublish ? (
        <button
          type="button"
          disabled={
            busy || !label.trim() || !changelog.trim() || !buildReference.trim()
          }
          onClick={() => setConfirmPublish(true)}
          className="mt-4 rounded-xl bg-tinta px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Publicar versão
        </button>
      ) : null}
      {confirmPublish ? (
        <div className="mt-4 rounded-xl border-2 border-ambar bg-ambar-tint p-4">
          <p className="font-semibold">Confirmar publicação de {label}?</p>
          <p className="mt-1 text-sm text-cinza">
            O histórico será registrado e a versão atual será atualizada.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void publish()}
              className="rounded-xl bg-tinta px-3 py-2 text-sm font-semibold text-white"
            >
              Confirmar publicação
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmPublish(false)}
              className="rounded-xl border border-borda px-3 py-2 text-sm font-semibold"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
      {confirmComplete ? (
        <div className="mt-4 rounded-xl border-2 border-verde bg-white p-4">
          <p className="font-semibold">Confirmar conclusão?</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void transition("CONCLUIDO")}
              className="rounded-xl bg-verde px-3 py-2 text-sm font-semibold text-white"
            >
              Confirmar conclusão
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmComplete(false)}
              className="rounded-xl border border-borda px-3 py-2 text-sm font-semibold"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className="mt-4 text-sm text-cinza" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function DashboardRelease({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const [content, setContent] = useState<unknown>(null);
  const [fileName, setFileName] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invalidFields, setInvalidFields] = useState<string[]>([]);
  const [inviteLink, setInviteLink] = useState("");
  const [message, setMessage] = useState("");
  if (
    !["ROADMAP_PAGO", "REFERENCIAS_PENDENTES", "EM_PRODUCAO"].includes(
      project.leadStatus,
    )
  )
    return null;
  async function selectFile(file: File | null) {
    setInvalidFields([]);
    setInviteLink("");
    setConfirm(false);
    setMessage("");
    if (!file) {
      setContent(null);
      setFileName("");
      return;
    }
    setFileName(file.name);
    try {
      setContent(JSON.parse(await file.text()));
    } catch {
      setContent(null);
      setInvalidFields(["content"]);
      setMessage("O arquivo precisa conter JSON válido do roadmap.");
    }
  }
  async function release() {
    setBusy(true);
    setMessage("");
    setInvalidFields([]);
    try {
      const result = await activateDashboard(project.id, content);
      setInviteLink(result.inviteLink);
      setConfirm(false);
      setMessage("Dashboard liberado. O convite está pronto para copiar.");
      onChanged();
    } catch (error) {
      const details =
        error && typeof error === "object" && "context" in error
          ? (error as { context?: { json?: () => Promise<unknown> } }).context
          : undefined;
      const body = details?.json
        ? ((await details.json().catch(() => null)) as {
            invalidFields?: unknown;
          } | null)
        : null;
      const fields = Array.isArray(body?.invalidFields)
        ? body.invalidFields.filter(
            (field): field is string => typeof field === "string",
          )
        : [];
      setInvalidFields(fields);
      setMessage(
        fields.length
          ? "O conteúdo não atende ao contrato do roadmap."
          : "Não foi possível liberar o dashboard.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setMessage("Link de convite copiado.");
    } catch {
      setMessage("Não foi possível copiar o link automaticamente.");
    }
  }
  return (
    <section className="rounded-2xl border border-borda bg-white p-5">
      <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-azul">
        Liberar dashboard
      </h2>
      <p className="mt-2 text-sm text-cinza">
        A liberação inicia a janela de decisão de 15 dias.
      </p>
      <label className="mt-4 block text-sm">
        <span className="mb-1 block text-cinza">
          Arquivo de conteúdo do roadmap
        </span>
        <input
          aria-label="Arquivo de conteúdo do roadmap"
          type="file"
          accept="application/json,.json"
          onChange={(event) => void selectFile(event.target.files?.[0] ?? null)}
        />
      </label>
      {fileName ? (
        <p className="mt-2 text-xs text-cinza">Selecionado: {fileName}</p>
      ) : null}
      {invalidFields.length ? (
        <p
          className="mt-3 rounded-xl border border-vermelho bg-vermelho-tint px-3 py-2 text-sm"
          role="alert"
        >
          Campos inválidos: {invalidFields.join(", ")}
        </p>
      ) : null}
      {!confirm ? (
        <button
          type="button"
          disabled={!content || busy}
          onClick={() => setConfirm(true)}
          className="mt-4 rounded-xl bg-tinta px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Liberar dashboard
        </button>
      ) : (
        <div className="mt-4 rounded-xl border-2 border-ambar bg-ambar-tint p-4">
          <p className="font-semibold">Confirmar liberação?</p>
          <p className="mt-1 text-sm text-cinza">
            O cliente receberá acesso à janela de decisão.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void release()}
              className="rounded-xl bg-tinta px-3 py-2 text-sm font-semibold text-white"
            >
              Confirmar liberação
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirm(false)}
              className="rounded-xl border border-borda px-3 py-2 text-sm font-semibold"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
      {inviteLink ? (
        <button
          type="button"
          onClick={() => void copyInvite()}
          className="mt-4 rounded-xl border border-borda px-3 py-2 text-sm font-semibold"
        >
          Copiar link de convite
        </button>
      ) : null}
      {message ? (
        <p className="mt-3 text-sm text-cinza" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}

const KANBAN_COLUMNS: Array<{ key: KanbanItem["status"]; label: string }> = [
  { key: "a_fazer", label: "A fazer" },
  { key: "em_andamento", label: "Em andamento" },
  { key: "concluido", label: "Concluído" },
];
function KanbanEditor({
  project,
  onChange,
}: {
  project: ProjectDetail;
  onChange: (items: KanbanItem[]) => void;
}) {
  const [items, setItems] = useState(sortKanbanItems(project.kanban));
  const [newTitle, setNewTitle] = useState("");
  const [saving, setSaving] = useState(false);
  async function save(item: Partial<KanbanItem> & { id?: string }) {
    setSaving(true);
    try {
      const saved = await saveKanbanItem(project.id, item);
      setItems((current) => {
        const nextItems = sortKanbanItems(
          saved.id === item.id
            ? current.map((entry) => (entry.id === saved.id ? saved : entry))
            : [...current, saved],
        );
        onChange(nextItems);
        return nextItems;
      });
    } finally {
      setSaving(false);
    }
  }
  async function create() {
    if (!newTitle.trim()) return;
    await save({
      title: newTitle.trim(),
      status: "a_fazer",
      position: items.length,
    });
    setNewTitle("");
  }
  return (
    <section className="rounded-2xl border border-borda bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-azul">
          Kanban do projeto
        </h2>
        <div className="flex gap-2">
          <input
            aria-label="Novo item"
            className="rounded-xl border border-borda px-3 py-2 text-sm"
            placeholder="Novo item"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button
            type="button"
            onClick={() => void create()}
            disabled={saving}
            className="rounded-xl bg-tinta px-3 py-2 text-sm font-semibold text-white"
          >
            Criar
          </button>
        </div>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {KANBAN_COLUMNS.map((column) => (
          <div className="rounded-xl bg-[#F3F3EF] p-3" key={column.key}>
            <h3 className="font-semibold">{column.label}</h3>
            <div className="mt-3 space-y-2">
              {items
                .filter((item) => item.status === column.key)
                .map((item) => (
                  <article
                    className="rounded-xl border border-borda bg-white p-3"
                    key={item.id}
                  >
                    <p className="font-medium">{item.title}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <select
                        aria-label={`Coluna de ${item.title}`}
                        className="rounded-lg border border-borda px-2 py-1 text-xs"
                        value={item.status}
                        onChange={(e) =>
                          void save({
                            ...item,
                            status: e.target.value as KanbanItem["status"],
                            completed_at:
                              e.target.value === "concluido"
                                ? new Date().toISOString()
                                : null,
                          })
                        }
                      >
                        <option value="a_fazer">A fazer</option>
                        <option value="em_andamento">Em andamento</option>
                        <option value="concluido">Concluído</option>
                      </select>
                      <input
                        aria-label={`Data de ${item.title}`}
                        className="rounded-lg border border-borda px-2 py-1 text-xs"
                        type="date"
                        value={item.scheduled_date ?? ""}
                        onChange={(e) =>
                          void save({
                            ...item,
                            scheduled_date: e.target.value || null,
                          })
                        }
                      />
                      <input
                        aria-label={`Posição de ${item.title}`}
                        className="w-20 rounded-lg border border-borda px-2 py-1 text-xs"
                        type="number"
                        min="0"
                        value={item.position}
                        onChange={(e) =>
                          void save({
                            ...item,
                            position: Number(e.target.value),
                          })
                        }
                      />
                    </div>
                  </article>
                ))}
            </div>
          </div>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-cinza">
          Nenhum item ainda. Crie o primeiro acima.
        </p>
      ) : null}
    </section>
  );
}

function ArchiveControl({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const eligible = project.projectStatus === "CONCLUIDO" || (project.leadStatus === "JANELA_DE_DECISAO" && project.effectiveAccessStatus === "EXPIRADO");
  const [tags, setTags] = useState("");
  const [internalReuse, setInternalReuse] = useState(false);
  const [publicCase, setPublicCase] = useState(false);
  const [confidential, setConfidential] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  if (!eligible) return null;
  const parsedTags = () => ({ componente: tags.split(",").map((tag) => tag.trim()).filter(Boolean) });
  async function archive() {
    try {
      await archiveProject({ projectId: project.id, tags: parsedTags(), internalReuse, publicCase, confidential });
      setMessage("Projeto arquivado e snapshot preservado."); setConfirm(false); onChanged();
    } catch { setMessage("Não foi possível arquivar este projeto."); }
  }
  return <section className="rounded-2xl border border-ambar bg-ambar-tint p-5"><h2 className="font-mono text-xs font-semibold uppercase tracking-[.14em]">Arquivar projeto</h2><p className="mt-2 text-sm text-cinza">Cria um snapshot preservado. O cliente perde o acesso; nenhum histórico é apagado.</p><label className="mt-4 block text-sm">Componentes ou padrões reutilizáveis<input className="mt-1 w-full rounded-lg border border-borda bg-white px-3 py-2" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="ex.: hero, formulário" /></label><div className="mt-3 grid gap-2 text-sm"><label><input type="checkbox" checked={internalReuse} onChange={(event) => setInternalReuse(event.target.checked)} /> Reutilizável internamente</label><label><input type="checkbox" checked={publicCase} onChange={(event) => setPublicCase(event.target.checked)} /> Autorizado para case</label><label><input type="checkbox" checked={confidential} onChange={(event) => setConfidential(event.target.checked)} /> Manter confidencial na biblioteca</label></div>{confirm ? <div className="mt-4 rounded-xl border border-ambar bg-white p-4"><p className="font-semibold">Confirmar arquivamento?</p><div className="mt-3 flex gap-2"><button type="button" className="rounded-xl bg-tinta px-4 py-2 text-sm font-semibold text-white" onClick={() => void archive()}>Confirmar arquivamento</button><button type="button" className="rounded-xl border border-borda px-4 py-2 text-sm" onClick={() => setConfirm(false)}>Cancelar</button></div></div> : <button type="button" className="mt-4 rounded-xl border border-tinta bg-white px-4 py-2 text-sm font-semibold" onClick={() => setConfirm(true)}>Arquivar</button>}{message ? <p className="mt-3 text-sm" role="status">{message}</p> : null}</section>;
}

export function AdminProjectDetailPage() {
  const { projectId = "" } = useParams();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const reload = () => {
    setLoading(true);
    setError(false);
    void loadAdminProject(projectId)
      .then(setProject)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    let active = true;
    void loadAdminProject(projectId)
      .then((value) => {
        if (active) setProject(value);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  if (loading)
    return (
      <AdminShell title="Ficha">
        <div className="py-16 text-center text-cinza" role="status">
          Carregando ficha…
        </div>
      </AdminShell>
    );
  if (error)
    return (
      <AdminShell title="Ficha">
        <ErrorState onRetry={reload} />
      </AdminShell>
    );
  if (!project)
    return (
      <AdminShell title="Ficha">
        <EmptyState>Projeto não encontrado.</EmptyState>
      </AdminShell>
    );
  const currentProject = project;
  async function convert() {
    try {
      await convertProject({
        projectId: currentProject.id,
        tier: currentProject.commercialTerms?.tier ?? "essencial",
        amountCents: currentProject.commercialTerms?.amount_cents ?? 0,
        paymentMethod: currentProject.commercialTerms?.payment_method ?? "",
        installments: currentProject.commercialTerms?.installments ?? 1,
        deadlineDays: currentProject.commercialTerms?.deadline_days ?? 0,
      });
      setMessage("Conversão registrada.");
      setConfirm(false);
      reload();
    } catch {
      setMessage("Não foi possível converter. Confira os dados comerciais.");
    }
  }
  return (
    <AdminShell title={project.clientName}>
      <section className="py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <Link className="text-sm text-azul underline" to="/no/projetos">
              ← Projetos
            </Link>
            <h2 className="mt-3 text-4xl font-extrabold tracking-[-0.05em]">
              {project.name}
            </h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {project.leadStatus === "JANELA_DE_DECISAO" ? (
              <button
                type="button"
                onClick={() => setConfirm(true)}
                className="rounded-xl bg-verde px-4 py-2.5 text-sm font-semibold text-white"
              >
                Converter
              </button>
            ) : null}
            {project.projectStatus === "CONVERTIDO" ? (
              <button
                type="button"
                onClick={() =>
                  void transitionProjectStatus(project.id, "AGENDADO").then(
                    reload,
                  )
                }
                className="rounded-xl border border-borda bg-white px-4 py-2.5 text-sm font-semibold"
              >
                Agendar
              </button>
            ) : null}
          </div>
        </div>
        {message ? (
          <p
            className="mt-4 rounded-xl border border-ambar bg-ambar-tint px-4 py-3 text-sm"
            role="status"
          >
            {message}
          </p>
        ) : null}
        {confirm ? (
          <div className="mt-5 rounded-2xl border-2 border-verde bg-white p-5">
            <h3 className="font-bold">Confirmar conversão?</h3>
            <p className="mt-2 text-sm text-cinza">
              Esta ação libera o acesso do projeto até o fim da execução.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => void convert()}
                className="rounded-xl bg-verde px-4 py-2 text-sm font-semibold text-white"
              >
                Confirmar
              </button>
              <button
                type="button"
                onClick={() => setConfirm(false)}
                className="rounded-xl border border-borda px-4 py-2 text-sm font-semibold"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : null}
        <div className="mt-7 grid gap-5 lg:grid-cols-2">
          <DataGroup title="Identificação">
            <DataField label="Cliente" value={project.clientName} />
            <DataField label="Empresa" value={project.companyName} />
            <DataField label="Contato" value={project.contact} />
            <DataField label="Nicho" value={project.niche} />
            <DataField label="Origem" value={project.origin} />
            <DataField label="Entrada" value={project.enteredAt} />
          </DataGroup>
          <DataGroup title="Diagnóstico">
            <DataField label="Respostas" value={project.diagnosis.answers} />
            <DataField
              label="Referências"
              value={project.diagnosis.references}
            />
            <DataField label="Materiais" value={project.diagnosis.materials} />
            <DataField
              label="Observações"
              value={project.diagnosis.observations}
            />
          </DataGroup>
          <CommercialForm
            project={project}
            onSaved={(terms) =>
              setProject({ ...project, commercialTerms: terms })
            }
          />
          <DataGroup title="Execução">
            <DataField label="Início" value={project.execution.startedAt} />
            <DataField label="Prazo" value={project.execution.deadline} />
            <DataField label="Fase" value={project.execution.phase} />
            <DataField label="Versão" value={project.execution.version} />
            <DataField
              label="Próxima entrega"
              value={project.execution.nextDelivery}
            />
            <DataField
              label="Dashboard do cliente"
              value={project.execution.clientDashboardUrl}
            />
            <DataField
              label="Links técnicos"
              value={project.execution.technicalLinks}
            />
            <DataField
              label="Observações internas"
              value={project.execution.internalNotes}
            />
          </DataGroup>
          <DataGroup title="Entregáveis">
            <DataField label="Roadmap" value={project.deliverables.roadmap} />
            <DataField
              label="Protótipo"
              value={project.deliverables.prototypeUrl}
            />
          </DataGroup>
        </div>
        <div className="mt-5">
          <DashboardRelease project={project} onChanged={reload} />
        </div>
        <div className="mt-5">
          <EditorExportsControl project={project} onChanged={reload} />
        </div>
        <div className="mt-5">
          <VersionControls project={project} onChanged={reload} />
        </div>
        <div className="mt-5">
          <ArchiveControl project={project} onChanged={reload} />
        </div>
        <div className="mt-5">
          <KanbanEditor
            project={project}
            onChange={(items) => setProject({ ...project, kanban: items })}
          />
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          {project.leadStatus === "ROADMAP_PAGO" ? (
            <button
              type="button"
              onClick={() =>
                void transitionLead(project.id, "REFERENCIAS_PENDENTES").then(
                  reload,
                )
              }
              className="rounded-xl border border-borda bg-white px-4 py-2 text-sm"
            >
              Mover para referências pendentes
            </button>
          ) : null}
          {project.leadStatus === "REFERENCIAS_PENDENTES" ? (
            <button
              type="button"
              onClick={() =>
                void transitionLead(project.id, "EM_PRODUCAO").then(reload)
              }
              className="rounded-xl border border-borda bg-white px-4 py-2 text-sm"
            >
              Mover para produção
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void activateBrandModule(project.id).then(reload)}
            className="rounded-xl border border-borda bg-white px-4 py-2 text-sm"
          >
            Ativar módulo Marca
          </button>
        </div>
      </section>
    </AdminShell>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  return (
    <li className="grid gap-2 border-b border-borda py-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <p className="text-sm font-semibold">{event.type}</p>
        <p className="mt-1 text-xs text-cinza">
          Ator: {event.actorLabel ?? event.actorId ?? "sistema"} ·{" "}
          {event.projectId ? (
            <Link
              className="text-azul underline"
              to={`/no/projetos/${event.projectId}`}
            >
              {event.projectName ?? event.projectId}
            </Link>
          ) : (
            "sem projeto"
          )}
        </p>
      </div>
      <time
        className="font-mono text-xs text-cinza"
        dateTime={event.occurredAt}
      >
        {new Intl.DateTimeFormat("pt-BR", {
          dateStyle: "short",
          timeStyle: "short",
          timeZone: "America/Sao_Paulo",
        }).format(new Date(event.occurredAt))}
      </time>
    </li>
  );
}
const ACTIVITY_VIEWS: Array<{ key: ActivityView; label: string }> = [
  { key: "hoje", label: "Hoje" },
  { key: "ontem", label: "Ontem" },
  { key: "pendencias", label: "Pendências" },
  { key: "atrasados", label: "Atrasados" },
  { key: "ultimos_7_dias", label: "Últimos 7 dias" },
  { key: "por_projeto", label: "Por projeto" },
  { key: "por_evento", label: "Por evento" },
];
export function AdminActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [kanban, setKanban] = useState<ActivityKanbanItem[]>([]);
  const [view, setView] = useState<ActivityView>("hoje");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const reload = () => {
    setLoading(true);
    setError(false);
    void Promise.all([listAdminActivity(), listAdminKanbanItems()])
      .then(([nextEvents, nextKanban]) => {
        setEvents(nextEvents);
        setKanban(nextKanban);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    let active = true;
    void Promise.all([listAdminActivity(), listAdminKanbanItems()])
      .then(([nextEvents, nextKanban]) => {
        if (active) {
          setEvents(nextEvents);
          setKanban(nextKanban);
        }
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const visible = useMemo(
    () => filterActivityEvents(events, view, undefined, kanban),
    [events, kanban, view],
  );
  const pageItems = visible.slice(page * 20, page * 20 + 20);
  const emptyLabel =
    view === "hoje" ? "Nenhuma atividade hoje." : "Nenhum item nesta visão.";
  return (
    <AdminShell title="Atividade">
      <section className="py-8">
        <div
          className="flex flex-wrap gap-2"
          role="tablist"
          aria-label="Visões de atividade"
        >
          {ACTIVITY_VIEWS.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={view === item.key}
              aria-pressed={view === item.key}
              key={item.key}
              onClick={() => {
                setView(item.key);
                setPage(0);
              }}
              className={`rounded-full px-3 py-2 text-xs font-semibold ${view === item.key ? "bg-tinta text-white" : "border border-borda bg-white"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {loading ? (
          <div className="py-16 text-center text-cinza" role="status">
            Carregando atividade…
          </div>
        ) : error ? (
          <div className="mt-7">
            <ErrorState onRetry={reload} />
          </div>
        ) : visible.length === 0 ? (
          <div className="mt-7">
            <EmptyState>{emptyLabel}</EmptyState>
          </div>
        ) : (
          <>
            <ul className="mt-6 rounded-2xl border border-borda bg-white px-5">
              {pageItems.map((event) => (
                <ActivityRow event={event} key={event.id} />
              ))}
            </ul>
            <nav
              aria-label="Paginação da atividade"
              className="mt-4 flex items-center justify-end gap-3"
            >
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
                className="rounded-lg border border-borda bg-white px-3 py-2 text-sm disabled:opacity-40"
              >
                Anterior
              </button>
              <span className="font-mono text-xs text-cinza">
                Página {page + 1}
              </span>
              <button
                type="button"
                disabled={(page + 1) * 20 >= visible.length}
                onClick={() => setPage((value) => value + 1)}
                className="rounded-lg border border-borda bg-white px-3 py-2 text-sm disabled:opacity-40"
              >
                Próxima
              </button>
            </nav>
          </>
        )}
      </section>
    </AdminShell>
  );
}
