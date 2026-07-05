'use client';

import type { ReactNode } from 'react';

interface PageLayoutProps {
  sidebar: ReactNode;
  mainArea: ReactNode;
  approvalModal: ReactNode;
  skillsPanel: ReactNode;
  settingsModal: ReactNode;
}

/**
 * Top-level page layout shell: sidebar on the left, main area on the right,
 * and floating modals / panels overlaid on top.
 */
export function PageLayout({
  sidebar,
  mainArea,
  approvalModal,
  skillsPanel,
  settingsModal,
}: PageLayoutProps) {
  return (
    <div className="app-root">
      {sidebar}
      <div className="main-area">{mainArea}</div>
      {approvalModal}
      {skillsPanel}
      {settingsModal}
    </div>
  );
}
