import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../auth/context';
import { HttpError } from '../lib/errors';
import { deferred } from '../test/workspaceFixtures';
import AccountSettingsPage from './AccountSettingsPage';

let client;
let account;
function mount(overrides = {}) {
  account = { id: 1, username: 'alice', email: 'alice@example.com', has_password: true, google_connected: false, ...overrides };
  function Provider() {
    const [user, setUser] = useState(account);
    client.loadAccount.mockResolvedValue(account);
    client.updateUsername.mockImplementation(async data => { account = { ...account, username: data.username }; setUser(account); return { user: account }; });
    client.updatePassword.mockImplementation(async () => { account = { ...account, has_password: true }; setUser(account); return { user: account }; });
    return <AuthContext.Provider value={{ user, client }}><AccountSettingsPage /></AuthContext.Provider>;
  }
  return render(<MemoryRouter><Provider /></MemoryRouter>);
}
const fill = (label, value) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
const click = name => fireEvent.click(screen.getByRole('button', { name, exact: true }));
async function ready() { await waitFor(() => expect(screen.getByLabelText('Username')).toBeEnabled()); }

beforeEach(() => {
  client = { loadAccount: vi.fn(), updateUsername: vi.fn(), updatePassword: vi.fn(), requestAccountVerification: vi.fn().mockResolvedValue({}), logout: vi.fn() };
});

it('renders account details and the password form appropriate for a password account', async () => {
  mount();
  await ready();
  expect(screen.getByRole('heading', { name: 'Account settings' })).toBeInTheDocument();
  expect(screen.getByLabelText('Username')).toHaveValue('alice');
  expect(screen.getByLabelText('Email address')).toHaveValue('alice@example.com');
  expect(screen.getByLabelText('Email address')).toHaveAttribute('readonly');
  expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send confirmation code' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute('href', '/workspaces');
});

it('disables changes after a load failure and allows retry', async () => {
  client.loadAccount.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect.');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  click('Try again');
  await ready();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('updates username and shared account display after confirming the password', async () => {
  mount();
  await ready();
  fill('Username', 'renamed');
  fill('Password to confirm username change', 'Original-secret!7524');
  click('Save changes');
  expect(await screen.findByRole('status')).toHaveTextContent('Username updated.');
  expect(client.updateUsername).toHaveBeenCalledExactlyOnceWith({ username: 'renamed', current_password: 'Original-secret!7524' });
  expect(screen.getByTitle('renamed')).toBeInTheDocument();
  expect(screen.getByLabelText('Password to confirm username change')).toHaveValue('');
});

it('rejects mismatched passwords without requesting a change', async () => {
  mount();
  await ready();
  fill('Current password', 'old-secret');
  fill('New password', 'A-different-secret!9274');
  fill('Confirm new password', 'mismatch');
  click('Change password');
  expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match.');
  expect(client.updatePassword).not.toHaveBeenCalled();
});

it('requires current password even for a Google-linked password account', async () => {
  mount({ google_connected: true });
  await ready();
  fill('Current password', 'Original-secret!7524');
  fill('New password', 'A-different-secret!9274');
  fill('Confirm new password', 'A-different-secret!9274');
  click('Change password');
  expect(await screen.findByRole('status')).toHaveTextContent('Other sessions have been signed out.');
  expect(client.updatePassword).toHaveBeenCalledExactlyOnceWith({ current_password: 'Original-secret!7524', password: 'A-different-secret!9274', confirm_password: 'A-different-secret!9274' });
  expect(screen.getByLabelText('New password')).toHaveValue('');
});

it('supports email confirmation and first password without asking for an old password', async () => {
  mount({ has_password: false, google_connected: true });
  await ready();
  expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Password to confirm username change')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Set password' })).toBeDisabled();
  click('Send confirmation code');
  expect(await screen.findByRole('status')).toHaveTextContent('Code sent.');
  expect(client.requestAccountVerification).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Resend in 60s' })).toBeDisabled();
  fill('Confirmation code', '12345678');
  fill('New password', 'A-different-secret!9274');
  fill('Confirm new password', 'A-different-secret!9274');
  click('Set password');
  await screen.findByLabelText('Current password');
  expect(client.updatePassword).toHaveBeenCalledExactlyOnceWith({ verification_code: '12345678', password: 'A-different-secret!9274', confirm_password: 'A-different-secret!9274' });
  expect(screen.getByText('Google account connected.')).toBeInTheDocument();
  expect(screen.queryByLabelText('Confirmation code')).not.toBeInTheDocument();
});

it('confirms a passwordless username change with a code', async () => {
  mount({ has_password: false, google_connected: true });
  await ready();
  fill('Username', 'new_name');
  fill('Confirmation code', '12345678');
  click('Save changes');
  expect(await screen.findByRole('status')).toHaveTextContent('Username updated.');
  expect(client.updateUsername).toHaveBeenCalledExactlyOnceWith({ username: 'new_name', verification_code: '12345678' });
  expect(screen.getByLabelText('Confirmation code')).toHaveValue('');
});

it.each([
  [400, { username: ['This username is unavailable.'] }, 'This username is unavailable.'],
  [400, { code: 'current_password_invalid' }, 'The current password is incorrect.'],
  [500, { detail: 'Traceback secret' }, 'The service is temporarily unavailable.'],
])('shows safe username errors for status %s', async (status, data, message) => {
  mount();
  await ready();
  client.updateUsername.mockRejectedValueOnce(new HttpError(status, data));
  fill('Username', 'different');
  fill('Password to confirm username change', 'wrong');
  click('Save changes');
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('alert')).not.toHaveTextContent(/Traceback|secret|HTTP/);
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});

it('shows rejected passwords and expired confirmation codes', async () => {
  mount({ has_password: false, google_connected: true });
  await ready();
  client.updatePassword.mockRejectedValueOnce(new HttpError(400, { code: 'account_verification_required' }));
  fill('Confirmation code', '12345678');
  fill('New password', 'A-different-secret!9274');
  fill('Confirm new password', 'A-different-secret!9274');
  click('Set password');
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid confirmation code');
  client.updatePassword.mockRejectedValueOnce(new HttpError(400, { password: ['This password is too common.'] }));
  click('Set password');
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This password is too common.'));
});

it('supports showing passwords and prevents duplicate saves while pending', async () => {
  mount();
  await ready();
  const gate = deferred();
  client.updatePassword.mockReturnValueOnce(gate.promise);
  fill('Current password', 'Original-secret!7524');
  fill('New password', 'A-different-secret!9274');
  fill('Confirm new password', 'A-different-secret!9274');
  click('Show new password');
  expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'text');
  click('Hide new password');
  expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'password');
  click('Change password');
  click('Saving…');
  expect(screen.getByLabelText('New password')).toBeDisabled();
  expect(client.updatePassword).toHaveBeenCalledTimes(1);
  await act(async () => gate.resolve({}));
  expect(screen.getByRole('status')).toHaveTextContent('Password saved.');
});

it('reports email delivery failures without enabling changes', async () => {
  mount({ has_password: false, google_connected: true });
  await ready();
  client.requestAccountVerification.mockRejectedValueOnce(new HttpError(503, { code: 'account_email_failed' }));
  click('Send confirmation code');
  expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't send your confirmation code.");
  expect(screen.getByRole('button', { name: 'Set password' })).toBeDisabled();
});
