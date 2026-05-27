'use client';
import './SkillsPanel.scss';

import { useState } from 'react';
import SkillsTab from './SkillsTab';
import ToolsTab from './ToolsTab';

interface Props {
    onPromptAI?: (message: string) => void;
}

type TabId = 'skills' | 'tools';

export default function SkillsPanel({ onPromptAI }: Props) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [activeTab, setActiveTab] = useState<TabId>('skills');

    const openToTab = (tab: TabId) => {
        setActiveTab(tab);
        setIsExpanded(true);
    };

    return (
        <div className={isExpanded ? 'skills-panel skills-panel--expanded' : 'skills-panel'}>
            {!isExpanded && (
                <div className="skills-panel-collapsed">
                    <button
                        className="skills-panel-collapsed-btn"
                        onClick={() => openToTab('skills')}
                        aria-label="Open skills tab"
                        title="Skills"
                    >
                        <span className="skills-panel-collapsed-btn-icon">⚡</span>
                        <span className="skills-panel-collapsed-btn-label">Skills</span>
                    </button>
                    <div className="skills-panel-collapsed-divider" />
                    <button
                        className="skills-panel-collapsed-btn"
                        onClick={() => openToTab('tools')}
                        aria-label="Open tools tab"
                        title="Tools"
                    >
                        <span className="skills-panel-collapsed-btn-icon">⚙</span>
                        <span className="skills-panel-collapsed-btn-label">Tools</span>
                    </button>
                </div>
            )}

            {isExpanded && (
                <div className="skills-panel-inner">
                    <div className="skills-panel-tabs">
                        <button
                            className={`skills-panel-tab${activeTab === 'skills' ? ' skills-panel-tab--active' : ''}`}
                            onClick={() => setActiveTab('skills')}
                        >
                            ⚡ Skills
                        </button>
                        <button
                            className={`skills-panel-tab${activeTab === 'tools' ? ' skills-panel-tab--active' : ''}`}
                            onClick={() => setActiveTab('tools')}
                        >
                            ⚙ Tools
                        </button>
                        <div className="skills-panel-tabs-spacer" />
                        <button
                            className="skills-panel-header-btn"
                            onClick={() => setIsExpanded(false)}
                            aria-label="Close panel"
                            title="Close"
                        >
                            ✕
                        </button>
                    </div>

                    {activeTab === 'skills' && <SkillsTab onPromptAI={onPromptAI} />}
                    {activeTab === 'tools' && <ToolsTab />}
                </div>
            )}
        </div>
    );
}
