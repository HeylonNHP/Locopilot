export function buildToolUseNudge(yolo: boolean): string {
    return (
        'Tool-use reminder: your previous response appears uncertain or incomplete. ' +
        'If you are not entirely certain, call web_search now and then answer using the fetched evidence. ' +
        'Do not use result_N placeholders; cite full URLs inline. ' +
        'If terminal access is needed, call run_command directly now. ' +
        (yolo
            ? 'The command will execute automatically.'
            : 'I (the app) will ask the human user for approval before execution.')
    );
}