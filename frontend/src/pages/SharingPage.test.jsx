import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../auth/context';
import SharingPage from './SharingPage';
import ManageCollaborators from '../components/ManageCollaborators';
import { response } from '../test/workspaceFixtures';

const file = { id: 'file-1', name: 'main', language: 'python' };
const owner = { id: 1, username: 'owner' };
const recipient = { id: 2, username: 'sara' };
let requests, invitations, members, client;
const mount = (element, path='/sharing/invitations') => render(<MemoryRouter initialEntries={[path]}>
  <AuthContext.Provider value={{ user: owner, client }}><Routes>
    <Route path='/sharing/:section' element={element} />
  </Routes></AuthContext.Provider></MemoryRouter>);
beforeEach(() => {
  requests=[]; members=[];
  invitations=[{ id:'invite-1', file, sender:owner, recipient, permission:'edit', status:'pending', updated_at:'2026-01-01T00:00:00Z' }];
  client={ logout:vi.fn(), fetch:vi.fn(async(url, options={}) => {
    requests.push({url,...options});
    if (url.includes('/users/')) return response([recipient]);
    if (url.endsWith('/manage/')) {
      if(options.method==='POST') return response(invitations[0],201);
      return response({ file, owner, collaborators:members, invitations });
    }
    if (url.includes('/members/')) { members=[]; return response({},204); }
    if(options.method==='POST') { invitations=[]; return response({status:'accepted'}); }
    if(url.endsWith('/files/')) return response([{...file, owner, permission:'view', updated_at:'2026-01-01'}]);
    return response(invitations);
  }) };
});
it('shows incoming invitations and accepts only the selected request', async()=>{
  mount(<SharingPage />);
  expect(await screen.findByText('main.py')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Accept',exact:true}));
  expect(await screen.findByText('Invitation accepted. Find the file in Shared With Me.')).toBeInTheDocument();
  expect(requests.find(r=>r.method==='POST')).toMatchObject({url:expect.stringContaining('/invitations/invite-1/'),body:'{"action":"accept"}'});
  expect(screen.queryByText('main.py')).not.toBeInTheDocument();
});
it('opens the original shared file route without a workspace link',async()=>{
  mount(<SharingPage />,'/sharing/files');
  const link=await screen.findByRole('link',{name:'Open File'});
  expect(link).toHaveAttribute('href','/shared/file-1');
  expect(screen.getByText('Can view')).toBeInTheDocument();
});
it('confirms cancellation of a sent invitation',async()=>{
  mount(<SharingPage />,'/sharing/sent');
  fireEvent.click(await screen.findByRole('button',{name:'Cancel Invitation'}));
  expect(requests.filter(r=>r.method==='POST')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Cancel invitation',exact:true}));
  await waitFor(()=>expect(requests.find(r=>r.method==='POST')?.body).toBe('{"action":"cancel"}'));
});
it('searches users and sends an edit invitation by default',async()=>{
  mount(<ManageCollaborators file={file} onClose={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText('Find a collaborator'),{target:{value:'sara'}});
  fireEvent.change(await screen.findByLabelText('Recipient'),{target:{value:'2'}});
  fireEvent.click(screen.getByRole('button',{name:'Send Invitation'}));
  expect(await screen.findByText('Invitation sent.')).toBeInTheDocument();
  expect(JSON.parse(requests.find(r=>r.method==='POST').body)).toEqual({recipient:2,permission:'edit'});
});
it('requires confirmation before revoking a collaborator',async()=>{
  members=[{user:recipient,permission:'edit'}];
  mount(<ManageCollaborators file={file} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button',{name:'Remove Access'}));
  expect(requests.filter(r=>r.method==='DELETE')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
  expect(await screen.findByText('Access removed.')).toBeInTheDocument();
  expect(requests.find(r=>r.method==='DELETE').url).toContain('/files/file-1/members/2/');
});
it('shows sanitized failures instead of internal server details',async()=>{
  client.fetch.mockResolvedValue(response({detail:'secret internal traceback'},500));
  mount(<SharingPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
  expect(screen.queryByText(/secret internal/)).not.toBeInTheDocument();
});
it('isolates list state when navigating between sharing sections',async()=>{
  mount(<SharingPage />);
  await screen.findByRole('button',{name:'Accept',exact:true});
  fireEvent.click(screen.getByRole('link',{name:'Shared With Me',exact:true}));
  expect(await screen.findByRole('link',{name:'Open File'})).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Accept',exact:true})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link',{name:'Invitations',exact:true}));
  expect(await screen.findByRole('button',{name:'Accept',exact:true})).toBeInTheDocument();
  expect(screen.queryByRole('link',{name:'Open File'})).not.toBeInTheDocument();
});
