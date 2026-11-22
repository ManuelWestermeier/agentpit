import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useActive } from '../lib/hooks';
import { act } from '../lib/store';
import type { PermissionRequest } from '../lib/types';
import { conn } from '../lib/ws';
import { DiffView } from './items/DiffView';
import { Markdown } from './items/Markdown';

/** Open approvals of the active project, pinned above the composer. */
export function Pending() {
  const { runner, project } = useActive();
  if (!runner?.pending?.length || !project) return null;
  return (
    <div className="pending" aria-live="polite">
      {runner.pending.map((req) =>
        req.toolName === 'AskUserQuestion' ? <QuestionCard key={req.id} req={req} projectId={project.id} />
          : req.toolName === 'ExitPlanMode' ? <PlanCard key={req.id} req={req} projectId={project.id} />
            : <PermCard key={req.id} req={req} projectId={project.id} />,
      )}
    </div>
  );
}

const respond = (projectId: string, id: string, body: Record<string, unknown>) =>
  act(() => conn.call('perm', { projectId, id, ...body }));

function PermCard({ req, projectId }: { req: PermissionRequest; projectId: string }) {
  const i = req.input ?? {};
  const isCmd = req.toolName === 'Bash' || req.toolName === 'PowerShell';
  const [cmd, setCmd] = useState<string>(isCmd ? String(i.command ?? '') : '');
  const [reason, setReason] = useState('');
  const [denying, setDenying] = useState(false);
  const edited = isCmd && cmd !== String(i.command ?? '');
  const title = req.title ?? `Claude möchte ${req.displayName ?? req.toolName} verwenden`;

  const allow = (always = false) => respond(projectId, req.id, {
    decision: always ? 'always' : 'allow',
    updatedInput: edited ? { ...i, command: cmd } : undefined,
  });

  let detail = null;
  if (isCmd) {
    detail = <textarea className="textarea" value={cmd} onChange={(e) => setCmd(e.target.value)} spellCheck={false} aria-label="Befehl (änderbar)" rows={Math.min(8, cmd.split('\n').length + 1)} />;
  } else if (req.toolName === 'Edit' && typeof i.old_string === 'string') {
    detail = <><div className="perm-sub mono">{i.file_path}</div><div style={{ background: 'var(--sunken)', borderRadius: 4, marginTop: 6 }}><DiffView a={i.old_string} b={String(i.new_string ?? '')} /></div></>;
  } else if (req.toolName === 'Write') {
    detail = <><div className="perm-sub mono">{i.file_path}</div><pre>{String(i.content ?? '').slice(0, 3000)}</pre></>;
  } else {
    detail = <pre>{JSON.stringify(i, null, 2).slice(0, 4000)}</pre>;
  }

  return (
    <div className="perm" role="group" aria-label={title}>
      <div className="perm-title"><ShieldAlert size={15} color="var(--amber)" />{title}</div>
      {(req.description || req.decisionReason || req.blockedPath) && (
        <div className="perm-sub">{[req.description, req.decisionReason, req.blockedPath && `Pfad: ${req.blockedPath}`].filter(Boolean).join(' · ')}</div>
      )}
      {isCmd && i.description && <div className="perm-sub">{i.description}</div>}
      {detail}
      {denying && (
        <input className="input" style={{ marginTop: 8 }} autoFocus placeholder="Begründung oder Alternative für Claude (optional)" value={reason}
          onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') respond(projectId, req.id, { decision: 'deny', message: reason || undefined }); }} />
      )}
      <div className="perm-actions">
        <button className="btn primary" onClick={() => allow(false)}>{edited ? 'Geänderten Befehl ausführen' : 'Erlauben'}</button>
        {req.canAlways && !edited && <button className="btn" onClick={() => allow(true)} title="Regel in .claude/settings.local.json speichern">Immer erlauben</button>}
        <span className="spacer" />
        {denying
          ? <button className="btn danger" onClick={() => respond(projectId, req.id, { decision: 'deny', message: reason || undefined })}>Ablehnen senden</button>
          : <button className="btn danger" onClick={() => setDenying(true)}>Ablehnen …</button>}
      </div>
    </div>
  );
}

function QuestionCard({ req, projectId }: { req: PermissionRequest; projectId: string }) {
  const questions: any[] = req.input?.questions ?? [];
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});

  const toggle = (qi: number, label: string, multi: boolean) => setSel((s) => {
    const cur = s[qi] ?? [];
    return { ...s, [qi]: multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label] };
  });
  const answerOf = (qi: number) => {
    const o = other[qi]?.trim();
    const picked = sel[qi] ?? [];
    return [...picked, ...(o ? [o] : [])].join(', ');
  };
  const complete = questions.every((_, qi) => answerOf(qi));
  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => { answers[q.question] = answerOf(qi); });
    respond(projectId, req.id, { decision: 'allow', updatedInput: { ...req.input, questions, answers } });
  };

  return (
    <div className="perm" role="group" aria-label="Rückfrage von Claude">
      <div className="perm-title">Claude hat eine Rückfrage</div>
      {questions.map((q, qi) => (
        <div className="q" key={qi}>
          <div className="q-head"><small>{q.header}</small>{q.question}</div>
          <div className="q-opts">
            {(q.options ?? []).map((o: any) => {
              const on = (sel[qi] ?? []).includes(o.label);
              return (
                <label key={o.label} className={`q-opt${on ? ' on' : ''}`}>
                  <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${req.id}-${qi}`} checked={on} onChange={() => toggle(qi, o.label, !!q.multiSelect)} />
                  <span>{o.label}{o.description && <small>{o.description}</small>}</span>
                </label>
              );
            })}
            <input className="input" placeholder="Eigene Antwort" value={other[qi] ?? ''} onChange={(e) => setOther((s) => ({ ...s, [qi]: e.target.value }))} />
          </div>
        </div>
      ))}
      <div className="perm-actions">
        <button className="btn primary" disabled={!complete} onClick={submit}>Antworten</button>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => respond(projectId, req.id, { decision: 'deny', message: 'Der Nutzer möchte die Frage nicht beantworten – entscheide selbst und nenne deine Annahme.' })}>Selbst entscheiden lassen</button>
      </div>
    </div>
  );
}

function PlanCard({ req, projectId }: { req: PermissionRequest; projectId: string }) {
  const [feedback, setFeedback] = useState('');
  const plan = String(req.input?.plan ?? '');
  return (
    <div className="perm" role="group" aria-label="Plan zur Freigabe">
      <div className="perm-title">Plan zur Freigabe</div>
      {plan ? <div className="plan"><Markdown text={plan} /></div> : <div className="perm-sub">Claude möchte den Planmodus verlassen und umsetzen.</div>}
      <textarea className="textarea" placeholder="Änderungswünsche (für „Weiter planen“)" value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} />
      <div className="perm-actions">
        <button className="btn primary" onClick={() => respond(projectId, req.id, { decision: 'allow', mode: 'acceptEdits' })}>Umsetzen, Edits automatisch</button>
        <button className="btn" onClick={() => respond(projectId, req.id, { decision: 'allow', mode: 'default' })}>Umsetzen, jeden Schritt fragen</button>
        <span className="spacer" />
        <button className="btn danger" onClick={() => respond(projectId, req.id, { decision: 'deny', message: feedback || 'Weiter planen.' })}>Weiter planen</button>
      </div>
    </div>
  );
}
