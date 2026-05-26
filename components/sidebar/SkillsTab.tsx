'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkillApiItem } from '@/app/api/skills/route';

interface Props {
    onPromptAI?: (message: string) => void;
}

export default function SkillsTab({ onPromptAI }: Props) {
    const [skills, setSkills] = useState<SkillApiItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [showCreateForm, setShowCreateForm] = useState(false);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [newDescription, setNewDescription] = useState('');
    const [newMode, setNewMode] = useState<'auto-invoke' | 'always-apply'>('auto-invoke');
    const [newGenerateAI, setNewGenerateAI] = useState(true);
    const [nameError, setNameError] = useState<string | null>(null);

    const [editingSkill, setEditingSkill] = useState<string | null>(null);
    const [editText, setEditText] = useState('');

    const togglingRef = useRef(false);

    const fetchSkills = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const res = await fetch('/api/skills');
            if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(data.error ?? `HTTP ${res.status}`);
            }
            const data = (await res.json()) as { skills: SkillApiItem[] };
            setSkills(data.skills ?? []);
            setCreating(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load skills');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchSkills();
    }, [fetchSkills]);

    useEffect(() => {
        const interval = setInterval(() => {
            if (!togglingRef.current) fetchSkills();
        }, 5000);
        return () => clearInterval(interval);
    }, [fetchSkills]);

    useEffect(() => {
        if (!creating) return;
        const timer = setTimeout(() => setCreating(false), 15000);
        return () => clearTimeout(timer);
    }, [creating]);

    const toggleSkill = useCallback(
        async (name: string, currentEnabled: boolean) => {
            const action = currentEnabled ? 'disable' : 'enable';
            togglingRef.current = true;
            setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled: !currentEnabled } : s)));
            try {
                const res = await fetch('/api/skills', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action, name }),
                });
                if (!res.ok) {
                    const data = (await res.json().catch(() => ({}))) as { error?: string };
                    throw new Error(data.error ?? `HTTP ${res.status}`);
                }
                const data = (await res.json()) as { skills: SkillApiItem[] };
                setSkills(data.skills ?? []);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to update skill');
                await fetchSkills();
            } finally {
                togglingRef.current = false;
            }
        },
        [fetchSkills],
    );

    const resetCreateForm = useCallback(() => {
        setShowCreateForm(false);
        setNewName('');
        setNewDescription('');
        setNewMode('auto-invoke');
        setNewGenerateAI(true);
        setCreating(false);
    }, []);

    const handleCreateSubmit = useCallback(() => {
        if (!onPromptAI || !newName.trim()) return;
        setCreating(true);
        let message: string;
        if (newGenerateAI) {
            message = `Please create a skill named "${newName.trim()}" with description "${newDescription.trim()}". The mode should be ${newMode}. Write detailed, specific instructions in the body. Use the create_skill tool.`;
        } else {
            message = `Please create a minimal skill named "${newName.trim()}" with description "${newDescription.trim()}". The mode should be ${newMode}. Use a simple placeholder body like "# ${newName.trim()}\n\nSkill instructions go here." Use the create_skill tool.`;
        }
        onPromptAI(message);
        setShowCreateForm(false);
        setNewName('');
        setNewDescription('');
        setNewMode('auto-invoke');
        setNewGenerateAI(true);
        setNameError(null);
    }, [onPromptAI, newName, newDescription, newMode, newGenerateAI]);

    const handleNameChange = useCallback((value: string) => {
        setNewName(value);
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            setNameError(null);
        } else if (trimmed.length > 64) {
            setNameError('Name must be 64 characters or fewer');
        } else if (/^[.\-]/.test(trimmed)) {
            setNameError('Name cannot start with . or -');
        } else if (/[/\\]/.test(trimmed) || trimmed.includes('..')) {
            setNameError('Name cannot contain path separators or ..');
        } else if (/\x00/.test(trimmed)) {
            setNameError('Name contains invalid characters');
        } else {
            setNameError(null);
        }
    }, []);

    const startEdit = useCallback((skill: SkillApiItem) => {
        setEditingSkill(skill.name);
        setEditText(skill.description ?? '');
    }, []);

    const cancelEdit = useCallback(() => {
        setEditingSkill(null);
        setEditText('');
    }, []);

    const submitEdit = useCallback(
        (skillName: string) => {
            if (!onPromptAI || !editText.trim()) return;
            const message = `Please update the skill "${skillName}" with the following changes: ${editText.trim()}. Use create_skill or patch_file as appropriate.`;
            onPromptAI(message);
            cancelEdit();
        },
        [onPromptAI, editText, cancelEdit],
    );

    const hasAI = Boolean(onPromptAI);

    return (
        <>
            <div className="skills-panel-header">
                <div className="skills-panel-header-title">Skills</div>
                <div className="skills-panel-header-actions">
                    {hasAI && (
                        <button
                            className="skills-panel-header-btn"
                            onClick={() => setShowCreateForm((s) => !s)}
                            aria-label="New skill"
                            title="New skill"
                        >
                            +
                        </button>
                    )}
                    <button
                        className="skills-panel-header-btn"
                        onClick={fetchSkills}
                        aria-label="Refresh skills"
                        title="Refresh"
                    >
                        ⟳
                    </button>
                </div>
            </div>

            {showCreateForm && (
                <div className="skills-panel-form">
                    <input
                        className="skills-panel-form-input"
                        placeholder="Skill name"
                        value={newName}
                        onChange={(e) => handleNameChange(e.target.value)}
                    />
                    {nameError && <div className="skills-panel-form-error">{nameError}</div>}
                    <textarea
                        className="skills-panel-form-textarea"
                        placeholder="Description"
                        rows={3}
                        value={newDescription}
                        onChange={(e) => setNewDescription(e.target.value)}
                    />
                    <div className="skills-panel-form-row">
                        <span className="font-12 text-secondary">Mode:</span>
                        <div className="skills-panel-form-radio-group">
                            <label className="skills-panel-form-radio-label">
                                <input
                                    type="radio"
                                    name="skill-mode"
                                    checked={newMode === 'auto-invoke'}
                                    onChange={() => setNewMode('auto-invoke')}
                                />
                                auto-invoke
                            </label>
                            <label className="skills-panel-form-radio-label">
                                <input
                                    type="radio"
                                    name="skill-mode"
                                    checked={newMode === 'always-apply'}
                                    onChange={() => setNewMode('always-apply')}
                                />
                                always-apply
                            </label>
                        </div>
                    </div>
                    <label className="skills-panel-form-row skills-panel-form-check">
                        <input
                            type="checkbox"
                            checked={newGenerateAI}
                            onChange={(e) => setNewGenerateAI(e.target.checked)}
                        />
                        <span className="font-12 text-secondary">Generate content with AI?</span>
                    </label>
                    <div className="skills-panel-form-actions">
                        <button className="skills-panel-form-btn-cancel" onClick={resetCreateForm}>
                            Cancel
                        </button>
                        <button
                            className="skills-panel-form-btn-create"
                            onClick={handleCreateSubmit}
                            disabled={!newName.trim() || creating || !!nameError}
                        >
                            {creating ? 'Creating…' : 'Create'}
                        </button>
                    </div>
                </div>
            )}

            {creating && (
                <div className="skills-panel-creating">
                    <span className="skills-panel-creating-dot" />
                    <span className="skills-panel-creating-text">Creating skill…</span>
                </div>
            )}

            <div className="skills-panel-body">
                {loading && skills.length === 0 && (
                    <div className="skills-panel-empty">Loading skills…</div>
                )}
                {error && (
                    <div className="skills-panel-error">
                        <span className="skills-panel-error-text">{error}</span>
                        <button className="skills-panel-error-retry" onClick={fetchSkills}>Retry</button>
                    </div>
                )}
                {!loading && skills.length === 0 && (
                    <div className="skills-panel-empty">
                        <p className="skills-panel-empty-title">No skills found</p>
                        <p className="skills-panel-empty-hint">
                            Create a skill by adding a folder under{' '}
                            <code className="skills-panel-empty-code">.locopilot/skills/&lt;name&gt;/</code>{' '}
                            with a{' '}
                            <code className="skills-panel-empty-code">SKILL.md</code> file.
                        </p>
                    </div>
                )}
                {skills.map((skill) => (
                    <div key={skill.name} className="skills-panel-skill">
                        <div className="skills-panel-skill-row">
                            <div className="skills-panel-skill-info">
                                <div className="skills-panel-skill-name">{skill.name}</div>
                                <div className="skills-panel-skill-badges">
                                    {skill.alwaysApply && (
                                        <span className="skills-panel-badge skills-panel-badge--always">
                                            always-apply
                                        </span>
                                    )}
                                    {skill.autoInvoke && (
                                        <span className="skills-panel-badge skills-panel-badge--auto">
                                            auto-invoke
                                        </span>
                                    )}
                                </div>
                            </div>
                            <label
                                className="skills-panel-toggle-switch"
                                aria-label={`Toggle ${skill.name}`}
                                htmlFor={`skill-toggle-${skill.name}`}
                            >
                                <input
                                    id={`skill-toggle-${skill.name}`}
                                    type="checkbox"
                                    checked={skill.enabled}
                                    onChange={() => toggleSkill(skill.name, skill.enabled)}
                                />
                                <span className="skills-panel-toggle-switch-slider" />
                            </label>
                        </div>
                        {skill.description && (
                            <div className="skills-panel-skill-desc">{skill.description}</div>
                        )}
                        {hasAI && (
                            <div className="skills-panel-skill-actions">
                                <button
                                    className="skills-panel-skill-edit-btn"
                                    onClick={() => startEdit(skill)}
                                    aria-label={`Edit ${skill.name}`}
                                    title="Edit"
                                >
                                    ✎
                                </button>
                            </div>
                        )}
                        {editingSkill === skill.name && (
                            <div className="skills-panel-edit-form">
                                <textarea
                                    className="skills-panel-form-textarea"
                                    rows={3}
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    placeholder="Describe the changes you want..."
                                />
                                <div className="skills-panel-form-actions">
                                    <button className="skills-panel-form-btn-cancel" onClick={cancelEdit}>
                                        Cancel
                                    </button>
                                    <button
                                        className="skills-panel-form-btn-create"
                                        onClick={() => submitEdit(skill.name)}
                                        disabled={!editText.trim()}
                                    >
                                        Update
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>

            <div className="skills-panel-footer">
                <p className="skills-panel-footer-hint">
                    Place skills in{' '}
                    <code>.locopilot/skills/&lt;name&gt;/SKILL.md</code>
                </p>
            </div>
        </>
    );
}
