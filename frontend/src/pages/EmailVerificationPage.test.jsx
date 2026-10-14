import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../auth/context';
import { HttpError } from '../lib/errors';
import { deferred } from '../test/workspaceFixtures';
import { CheckEmailPage, VerifyEmailPage } from './EmailVerificationPage';

let client;
const token = 'a'.repeat(43);
function LocationObserver() {
  const location = useLocation();
  return <span hidden data-testid="current-hash">{location.hash}</span>;
}
function mount(path = '/check-email') {
  return render(<StrictMode><MemoryRouter initialEntries={[path]}>
    <AuthContext.Provider value={{ client }}>
      <LocationObserver />
      <Routes>
        <Route path="/check-email" element={<CheckEmailPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/login" element={<h1>Login page</h1>} />
      </Routes>
    </AuthContext.Provider>
  </MemoryRouter></StrictMode>);
}

beforeEach(() => {
  client = { verifyEmail: vi.fn(), resendVerification: vi.fn().mockResolvedValue({}) };
});

it('automatically verifies once in StrictMode, removes the fragment, and offers login', async () => {
  client.verifyEmail.mockResolvedValue({ code: 'email_verified' });
  mount(`/verify-email#token=${token}`);
  await screen.findByRole('heading', { name: 'Email verified' });
  expect(client.verifyEmail).toHaveBeenCalledExactlyOnceWith(token);
  expect(screen.getByTestId('current-hash').textContent).toBe('');
  expect(localStorage.length).toBe(0);
  fireEvent.click(screen.getByRole('link', { name: 'Go to Login' }));
  expect(screen.getByRole('heading', { name: 'Login page' })).toBeInTheDocument();
});

it.each([
  ['verification_expired', 'Link expired', 'has expired'],
  ['verification_invalid', 'Invalid link', 'is invalid'],
  ['verification_used', 'Link already used', 'already been used'],
])('shows the %s state without leaking response details', async (code, heading, message) => {
  client.verifyEmail.mockRejectedValue(new HttpError(400, { code, detail: 'SECRET traceback' }));
  mount(`/verify-email#token=${token}`);
  await screen.findByRole('heading', { name: heading });
  expect(screen.getByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('alert')).not.toHaveTextContent(/SECRET|HTTP|traceback/);
  fireEvent.click(screen.getByRole('link', { name: 'Request a new verification email' }));
  expect(screen.getByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
});

it.each(['', '#token=invalid', '?token=unsafe'])('rejects a missing or malformed fragment %s without a request', async fragment => {
  mount(`/verify-email${fragment}`);
  await screen.findByRole('heading', { name: 'Invalid link' });
  expect(client.verifyEmail).not.toHaveBeenCalled();
});

it('shows verification loading and handles network failure', async () => {
  const gate = deferred();
  client.verifyEmail.mockReturnValue(gate.promise.then(() => { throw new TypeError('Failed to fetch'); }));
  mount(`/verify-email#token=${token}`);
  expect(screen.getByRole('status')).toHaveTextContent('Verifying your email');
  await act(async () => gate.resolve());
  expect(screen.getByRole('alert')).toHaveTextContent('Could not connect.');
  expect(client.verifyEmail).toHaveBeenCalledTimes(1);
});

it('resends once, displays a generic result, and starts a cooldown', async () => {
  vi.useFakeTimers();
  const gate = deferred();
  client.resendVerification.mockReturnValue(gate.promise);
  mount();
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'alice@example.com' } });
  const button = screen.getByRole('button', { name: 'Resend verification email' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  expect(client.resendVerification).toHaveBeenCalledExactlyOnceWith('alice@example.com');
  await act(async () => gate.resolve({}));
  expect(screen.getByRole('status')).toHaveTextContent('If this address needs verification');
  expect(screen.getByRole('button', { name: 'Resend in 60s' })).toBeDisabled();
  await act(async () => vi.advanceTimersByTime(1000));
  expect(screen.getByRole('button', { name: 'Resend in 59s' })).toBeDisabled();
});

it('prefills the registered address and applies the initial resend cooldown', () => {
  mount({ pathname: '/check-email', state: { email: 'alice@example.com', justRegistered: true } });
  expect(screen.getByLabelText('Email address')).toHaveValue('alice@example.com');
  expect(screen.getByRole('button', { name: 'Resend in 60s' })).toBeDisabled();
});

it('shows rate limiting and keeps resend disabled during the cooldown', async () => {
  client.resendVerification.mockRejectedValue(new HttpError(429, {}));
  mount();
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'alice@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Too many attempts.'));
  expect(screen.getByRole('button', { name: 'Resend in 60s' })).toBeDisabled();
});

it('allows retry after a resend network error', async () => {
  client.resendVerification.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  mount();
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'alice@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect.');
  expect(screen.getByRole('button', { name: 'Resend verification email' })).toBeEnabled();
});
