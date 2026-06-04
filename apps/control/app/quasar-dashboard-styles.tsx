export function DashboardStyles() {
  return <style jsx global>{dashboardCss}</style>;
}

const dashboardCss = `
	      .shell {
	        width: min(1440px, 100%);
        margin: 0 auto;
        padding: 24px;
      }
      .shell .topbar {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 24px;
        padding: 18px 0 22px;
        border-bottom: 1px solid var(--line);
      }
      .shell h1 {
        margin: 0;
        font-size: 30px;
        letter-spacing: 0;
      }
      .shell p {
        margin: 6px 0 0;
        color: var(--muted);
      }
      .shell .status-pill {
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 8px 10px;
        color: var(--accent);
        background: var(--panel);
        white-space: nowrap;
      }
      .shell .top-actions {
        display: flex;
        gap: 10px;
        align-items: center;
      }
      .shell .search-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 150px 120px;
        gap: 10px;
        margin: 22px 0;
      }
      .shell .control-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(180px, 320px);
        gap: 10px;
        margin: 18px 0 0;
      }
      .shell input,
      .shell select,
      .shell button {
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--text);
        background: var(--panel);
        padding: 11px 12px;
      }
      .shell button {
        background: var(--accent);
        color: #07110d;
        font-weight: 700;
        cursor: pointer;
      }
      .shell button:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
      .shell .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
      }
      .shell .panel {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        padding: 16px;
        min-width: 0;
      }
      .shell .wide {
        grid-column: 1 / -1;
      }
      .shell h2 {
        margin: 0 0 12px;
        font-size: 16px;
        letter-spacing: 0;
      }
      .shell pre {
        margin: 0;
        max-height: 420px;
        overflow: auto;
        border-radius: 6px;
        background: #0b0d10;
        padding: 12px;
        color: #cfe8db;
      }
      .shell .list {
        display: grid;
        gap: 8px;
      }
      .shell .table {
        display: grid;
        gap: 8px;
      }
      .shell .row,
      .shell .session-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto auto auto;
        gap: 10px;
        align-items: center;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 10px;
        background: var(--panel-2);
      }
      .shell .session-row {
        grid-template-columns: minmax(180px, 1.2fr) 96px 140px 92px minmax(160px, 1fr) minmax(160px, 1fr) 180px 92px;
      }
      .shell .tool-row {
        display: grid;
        grid-template-columns: 220px 120px minmax(0, 1fr);
        gap: 10px;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 10px;
        background: var(--panel-2);
      }
      .shell .artifact-row {
        display: grid;
        grid-template-columns: 140px minmax(0, 1fr);
        gap: 10px;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 10px;
        background: var(--panel-2);
      }
      .shell .filter-row,
      .shell .graph-counts {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
      }
      .shell .graph-counts {
        grid-template-columns: repeat(6, minmax(0, 1fr));
        margin-bottom: 14px;
      }
      .shell .graph-counts span {
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 8px;
        background: var(--panel-2);
      }
      .shell .alias-form {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
        margin-bottom: 12px;
      }
      .shell .empty {
        color: var(--muted);
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 14px;
        background: var(--panel-2);
      }
      .shell .meta-grid {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 8px;
        margin-bottom: 14px;
      }
      .shell .meta-grid span {
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 8px;
        background: var(--panel-2);
      }
      .shell .timeline {
        display: grid;
        gap: 8px;
        margin-bottom: 18px;
      }
      .shell .event-row {
        display: grid;
        grid-template-columns: 48px 110px 120px minmax(0, 1fr);
        gap: 10px;
        align-items: start;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 10px;
        background: var(--panel-2);
      }
      .shell .event-row p {
        margin: 0;
        color: var(--text);
        overflow-wrap: anywhere;
      }
      .shell strong,
      .shell span,
      .shell small {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .shell small {
        color: var(--muted);
      }
      .shell .error {
        border: 1px solid #7c2d2d;
        background: #301616;
        color: #ffd8d8;
        border-radius: 6px;
        padding: 10px 12px;
        margin-bottom: 16px;
      }
      @media (max-width: 800px) {
        .shell .topbar,
        .shell .search-row,
        .shell .grid {
          grid-template-columns: 1fr;
        }
        .shell .topbar {
          display: grid;
          align-items: start;
        }
        .shell .top-actions {
          align-items: stretch;
        }
        .shell .session-row {
          grid-template-columns: 1fr;
        }
        .shell .control-row,
        .shell .filter-row,
        .shell .graph-counts,
        .shell .meta-grid,
        .shell .event-row,
        .shell .tool-row,
        .shell .artifact-row {
	          grid-template-columns: 1fr;
	        }
	      }
	    `;
