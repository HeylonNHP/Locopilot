// GET /api/sessions/[id] - get session messages
// DELETE /api/sessions/[id] - delete a session
import { NextRequest, NextResponse } from 'next/server';
import { loadSessionMessages, deleteSession, listSessions } from '../../../../history';

export async function GET(
    _request: NextRequest,
    { params }: { params: { id: string } },
): Promise<NextResponse> {
    try {
        const sessionId = Number(params.id);
        if (Number.isNaN(sessionId)) {
            return NextResponse.json(
                { error: 'Invalid session ID. Must be a number.' },
                { status: 400 },
            );
        }

        // Verify session exists
        const sessions = listSessions();
        const session = sessions.find((s) => s.id === sessionId);
        if (!session) {
            return NextResponse.json(
                { error: `Session with id ${sessionId} not found.` },
                { status: 404 },
            );
        }

        const messages = loadSessionMessages(sessionId);
        return NextResponse.json({ session, messages });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
            { error: `Failed to load session: ${message}` },
            { status: 500 },
        );
    }
}

export async function DELETE(
    _request: NextRequest,
    { params }: { params: { id: string } },
): Promise<NextResponse> {
    try {
        const sessionId = Number(params.id);
        if (Number.isNaN(sessionId)) {
            return NextResponse.json(
                { error: 'Invalid session ID. Must be a number.' },
                { status: 400 },
            );
        }

        // Verify session exists
        const sessions = listSessions();
        const session = sessions.find((s) => s.id === sessionId);
        if (!session) {
            return NextResponse.json(
                { error: `Session with id ${sessionId} not found.` },
                { status: 404 },
            );
        }

        deleteSession(sessionId);
        return NextResponse.json({ success: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
            { error: `Failed to delete session: ${message}` },
            { status: 500 },
        );
    }
}
