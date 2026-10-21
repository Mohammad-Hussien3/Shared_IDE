import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { AuthContext } from '../auth/context';
import CollaborativeEditor from './CollaborativeEditor';

const doubles = vi.hoisted(() => ({ providers: [], bindings: [], cursors: [], editorProps: null }));
vi.mock('y-monaco', () => ({ MonacoBinding: class {
  constructor() { this.destroy = vi.fn(); doubles.bindings.push(this); }
} }));
vi.mock('../collaboration/cursors', () => ({ CollaborativeCursors: class {
  constructor() { this.destroy = vi.fn(); doubles.cursors.push(this); }
} }));
vi.mock('../collaboration/provider', () => ({ CollaborationProvider: class {
  constructor(options) { Object.assign(this, options); this.doc = new Y.Doc(); this.text = this.doc.getText('content');
    this.destroy = vi.fn(() => this.doc.destroy()); doubles.providers.push(this); }
  connect() { this.onStatus({ synced:false, saved:false, editable:false, message:'Connecting…' }); }
} }));
vi.mock('./CodeEditor', async () => {
  const { useEffect } = await import('react');
  return { default: function Editor(props) {
    const { options, onMount } = props; doubles.editorProps = props;
    useEffect(() => { onMount({ getModel: () => ({}) }, {}); }, [onMount]);
    return <textarea aria-label="Shared code" readOnly={options.readOnly} />;
  } };
});
const auth = { user:{id:1}, client:{ getAccessToken:vi.fn(),restore:vi.fn() } };
const view = (id, props = {}) => <AuthContext.Provider value={auth}><CollaborativeEditor key={id} file={{id,name:'test.py',language:'python'}} theme="dark" {...props} /></AuthContext.Provider>;
afterEach(() => { doubles.providers.length=0; doubles.bindings.length=0; doubles.cursors.length=0; });
it('waits for synchronization before binding or allowing edits and reports saved state', () => {
  const onContent = vi.fn(), onStatus = vi.fn(); render(view('first',{onContent,onStatus}));
  const provider = doubles.providers[0]; expect(screen.getByLabelText('Shared code')).toHaveAttribute('readonly');
  expect(doubles.bindings).toHaveLength(0);
  act(() => provider.onStatus({ synced:true,saved:true,editable:true,permission:'edit' }));
  expect(screen.getByText('Saved · Live collaboration')).toBeVisible();
  expect(screen.getByLabelText('Shared code')).not.toHaveAttribute('readonly'); expect(doubles.bindings).toHaveLength(1);
  act(() => provider.text.insert(0,'current source'));
  expect(onContent).toHaveBeenCalledWith('current source');
  act(() => provider.onStatus({ synced:true,saved:false,editable:true,permission:'edit' }));
  expect(screen.getByText('Syncing changes…')).toBeVisible(); expect(onStatus.mock.lastCall[0].saved).toBe(false);
});
it('keeps viewers read only and removes active bindings on revocation', () => {
  render(view('first')); const provider=doubles.providers[0];
  act(() => provider.onStatus({ synced:true,saved:true,editable:false,permission:'view' }));
  expect(screen.getByText('Read only')).toBeVisible(); expect(screen.getByLabelText('Shared code')).toHaveAttribute('readonly');
  act(() => provider.onStatus({ synced:true,saved:false,editable:false,fatal:true,message:'Your access to this file was removed.' }));
  expect(screen.getByText('Your access to this file was removed.')).toBeVisible();
  expect(doubles.bindings[0].destroy).toHaveBeenCalledOnce(); expect(doubles.cursors[0].destroy).toHaveBeenCalledOnce();
});
it('cleans up providers and editor bindings when switching files', () => {
  const controllerRef={current:null}; const rendered=render(view('one',{controllerRef})); const first=doubles.providers[0];
  act(() => first.onStatus({synced:true,saved:true,editable:true,permission:'owner'}));
  rendered.rerender(view('two',{controllerRef}));
  expect(first.destroy).toHaveBeenCalledOnce(); expect(doubles.bindings[0].destroy).toHaveBeenCalledOnce();
  expect(controllerRef.current).toBe(doubles.providers[1]); rendered.unmount(); expect(controllerRef.current).toBeNull();
});

it('preserves editor settings and callbacks without overriding collaboration permissions', () => {
  const onMount = vi.fn(), onValidate = vi.fn();
  const rendered = render(view('first', {
    onMount, onValidate, options: { fontSize: 18, wordWrap: 'on', readOnly: false },
  }));
  expect(onMount).toHaveBeenCalledOnce();
  expect(doubles.editorProps.onValidate).toBe(onValidate);
  expect(doubles.editorProps.options).toMatchObject({ fontSize: 18, wordWrap: 'on', readOnly: true });
  act(() => doubles.providers[0].onStatus({ synced: true, saved: true, editable: false, permission: 'view' }));
  expect(screen.getByLabelText('Shared code')).toHaveAttribute('readonly');
  const nextValidation = vi.fn();
  rendered.rerender(view('first', {
    onMount, onValidate: nextValidation, options: { fontSize: 22, wordWrap: 'off' },
  }));
  expect(doubles.providers).toHaveLength(1);
  expect(onMount).toHaveBeenCalledOnce();
  expect(doubles.editorProps.onValidate).toBe(nextValidation);
  expect(doubles.editorProps.options).toMatchObject({ fontSize: 22, wordWrap: 'off', readOnly: true });
});

it('keeps the provider, CRDT binding, and cursor presence when a tab becomes inactive', () => {
  const onMount = vi.fn();
  const rendered = render(view('first', { active: true, onMount }));
  const provider = doubles.providers[0];
  act(() => provider.onStatus({ synced: true, saved: true, editable: true, permission: 'edit' }));
  rendered.rerender(view('first', { active: false, onMount }));
  expect(provider.destroy).not.toHaveBeenCalled();
  expect(doubles.bindings[0].destroy).not.toHaveBeenCalled();
  expect(doubles.cursors[0].destroy).not.toHaveBeenCalled();
  rendered.rerender(view('first', { active: true, onMount }));
  expect(doubles.providers).toHaveLength(1);
  expect(onMount).toHaveBeenCalledTimes(2);
});
