import React from 'react';

export const STATUS = {
  running: 'running', completed: 'completed', failed: 'failed', queued: 'queued',
  awaiting_approval: 'awaiting approval', interrupted: 'interrupted', planning: 'planning', blocked: 'blocked', cancelled: 'cancelled', limit_reached: 'limit reached', succeeded: 'succeeded', not_connected: 'not connected', idle: 'idle', degraded: 'degraded',
};

export const Status = ({ value }) => (
  <span className={`status s-${value}`}><i />{STATUS[value] || value}</span>
);

export const DemoTag = ({ title = 'Dado demonstrativo, não real' }) => <span className="demo" title={title}>DEMO</span>;

export const Panel = ({ title, right, children, className = '', demo }) => (
  <section className={`panel ${className}`}>
    <header><h3>{title}{demo && <DemoTag />}</h3><div className="right">{right}</div></header>
    <div className="body">{children}</div>
  </section>
);

export const Empty = ({ children }) => <div className="empty">{children}</div>;

export const Btn = ({ kind = '', ...p }) => <button className={`btn ${kind}`} {...p} />;

export const Progress = ({ done, total }) => (
  <div className="progress" title={`${done}/${total}`}>
    <div style={{ width: total ? `${(done / total) * 100}%` : 0 }} />
  </div>
);

export const fmtTime = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });

export function taskBlocked(task, tasks) {
  return task.dependsOn.some((d) => tasks.find((t) => t.id === d)?.status !== 'completed');
}
