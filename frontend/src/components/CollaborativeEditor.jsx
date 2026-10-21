import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MonacoBinding } from 'y-monaco';
import { CollaborativeCursors } from '../collaboration/cursors';
import { useAuth } from '../auth/context';
import CodeEditor from './CodeEditor';
import { CollaborationProvider } from '../collaboration/provider';
import { defineEditorThemes } from '../lib/editorThemes';
import { languageFor } from '../lib/ideFiles';

export default function CollaborativeEditor({ file, theme, active = true, controllerRef, onContent, onStatus, onPresence, onMount, onValidate, options = {} }) {
  const { client, user } = useAuth();
  const callbacks = useRef({ onContent, onStatus, onPresence, onMount });
  useLayoutEffect(() => { callbacks.current = { onContent, onStatus, onPresence, onMount }; }, [onContent, onStatus, onPresence, onMount]);
  const [mounted, setMounted] = useState(null);
  const mountEditor = useCallback((editor, monaco) => {
    setMounted({ editor, monaco });
  }, []);
  useEffect(() => {
    if (active && mounted) {
      mounted.editor.layout?.();
      callbacks.current.onMount?.(mounted.editor, mounted.monaco);
    }
  }, [active, mounted]);
  const [people, setPeople] = useState([]);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState({ saved: false, synced: false, message: 'Connecting…' });
  const [provider, setProvider] = useState(null);
  useEffect(() => {
    const connection = new CollaborationProvider({ fileId: file.id, userId: user.id,
      getToken: () => client.getAccessToken(), refreshToken: () => client.restore(),
      onStatus: state => { setStatus(state); callbacks.current.onStatus?.(state); },
      onReset: () => setGeneration(value => value + 1),
    });
    setProvider(connection);
    if (controllerRef) controllerRef.current = connection;
    const change = () => callbacks.current.onContent?.(connection.text.toString());
    connection.text.observe(change);
    connection.connect();
    return () => {
      if (controllerRef?.current === connection) controllerRef.current = null;
      connection.text.unobserve(change); connection.destroy();
    };
  }, [file.id, user.id, client, generation, controllerRef]);
  useEffect(() => {
    if (!mounted || !provider || !status.synced || status.fatal) return;
    const { editor, monaco } = mounted;
    const binding = new MonacoBinding(provider.text, editor.getModel(), new Set([editor]));
    const cursors = new CollaborativeCursors(provider, editor, monaco, users => {
      setPeople(users); callbacks.current.onPresence?.(users);
    });
    return () => { cursors.destroy(); binding.destroy(); };
  }, [mounted, provider, status.synced, status.fatal]);
  return <div className="collaborative-editor">
    <div className="collaboration-status" role="status">
      <span>{status.message || (status.saved ? 'Saved · Live collaboration' : 'Syncing changes…')}</span>
      {status.permission === 'view' && <span>Read only</span>}
      <div className="collaboration-people" aria-label="Connected collaborators">
        {people.map(person => <span key={person.id} style={{ '--collaborator-color': person.color }}
          className="collaboration-person" title={`${person.username} · Online`}>
          <i aria-hidden="true" />{person.username}
        </span>)}
      </div>
    </div>
    <div className="collaboration-monaco">
      <CodeEditor workspaceId={`shared-${file.id}`} path={`file:///shared-${file.id}/${file.id}`}
        height="100%" theme={`spark-${theme}`} beforeMount={defineEditorThemes} language={languageFor(file)}
        defaultValue="" onMount={mountEditor} onValidate={onValidate}
        options={{ automaticLayout: true, minimap: { enabled: false }, ...options,
          readOnly: options.readOnly || !status.synced || !status.editable }} />
    </div>
  </div>;
}
