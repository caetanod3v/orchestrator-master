import React from 'react';
import TerminalGrid from '../components/TerminalGrid.jsx';

/** Cockpit: a única área principal. Os terminais reais dos agentes do ambiente aberto ocupam todo o espaço; o resto (missões, ciclo, inspetor, grafo) saiu da interface. */
export default function Cockpit(props) {
  return <TerminalGrid {...props} />;
}
