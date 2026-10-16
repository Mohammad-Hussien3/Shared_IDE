import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../auth/context';
import { HttpError } from '../lib/errors';
import { deferred } from '../test/workspaceFixtures';
import AuthPage from './AuthPage';
import { ForgotPasswordPage, ResetPasswordPage } from './PasswordResetPage';

let client;
const token = 'a'.repeat(43);
function LocationObserver() {
  const location = useLocation();
  return <span hidden data-testid="url">{location.pathname}{location.search}{location.hash}</span>;
}
function mount(path = '/forgot-password') {
  return render(<StrictMode><MemoryRouter initialEntries={[path]}>
    <AuthContext.Provider value={{ client, user: null, error: '', setError: vi.fn() }}>
      <LocationObserver />
      <Routes>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/login" element={<AuthPage />} />
        <Route path="/register" element={<AuthPage register />} />
      </Routes>
    </AuthContext.Provider>
  </MemoryRouter></StrictMode>);
}
const fill = (label, value) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
const click = name => fireEvent.click(screen.getByRole('button', { name, exact: true }));
function fillPasswords(password = 'Recovery-secret!9841', confirmation = password) {
  fill('New password', password);
  fill('Confirm new password', confirmation);
}

beforeEach(() => {
  client = { requestPasswordReset: vi.fn().mockResolvedValue({}), confirmPasswordReset: vi.fn().mockResolvedValue({ code: 'password_reset' }), authenticate: vi.fn() };
});

it('links from sign in to recovery and back without changing Google sign-in', async () => {
  mount('/login');
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Forgot password?' }));
  expect(screen.getByRole('heading', { name: 'Forgot password?' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Back to Sign In' }));
  expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  expect(client.authenticate).not.toHaveBeenCalled();
});

it('does not add a forgot-password link to registration', () => {
  mount('/register');
  expect(screen.queryByRole('link', { name: 'Forgot password?' })).not.toBeInTheDocument();
});

it.each(['owner@example.com', 'unknown@example.com'])('shows the same generic message for %s', async email => {
  mount();
  fill('Email address', email);
  click('Send Reset Link');
  expect(await screen.findByRole('status')).toHaveTextContent("If an account exists with this email, we've sent a password reset link.");
  expect(client.requestPasswordReset).toHaveBeenCalledExactlyOnceWith(email);
  expect(screen.queryByText(/not registered|account found/i)).not.toBeInTheDocument();
});

it('disables the request form and prevents duplicate submissions while sending', async () => {
  const gate = deferred();
  client.requestPasswordReset.mockReturnValue(gate.promise);
  mount();
  fill('Email address', 'owner@example.com');
  click('Send Reset Link');
  click('Sending…');
  expect(screen.getByLabelText('Email address')).toBeDisabled();
  expect(client.requestPasswordReset).toHaveBeenCalledTimes(1);
  await act(async () => gate.resolve({}));
  expect(screen.getByRole('status')).toHaveTextContent('30 minutes');
});

it.each([
  [new TypeError('Failed to fetch'), 'Could not connect.'],
  [new HttpError(429, { detail: 'private implementation' }), 'Too many attempts.'],
  [new HttpError(403, { code: 'csrf_failed' }), "We couldn't verify this request."],
])('handles request failures safely', async (error, message) => {
  client.requestPasswordReset.mockRejectedValue(error);
  mount();
  fill('Email address', 'owner@example.com');
  click('Send Reset Link');
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('alert')).not.toHaveTextContent(/HTTP|private/);
  expect(screen.getByRole('button', { name: 'Send Reset Link' })).toBeEnabled();
});

it('keeps the reset token in memory, submits once, and redirects to login with success', async () => {
  const gate = deferred();
  client.confirmPasswordReset.mockReturnValue(gate.promise);
  mount(`/reset-password#token=${token}`);
  await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent(/^\/reset-password$/));
  expect(client.confirmPasswordReset).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
  fillPasswords();
  click('Reset Password');
  click('Resetting…');
  expect(screen.getByLabelText('New password')).toBeDisabled();
  expect(client.confirmPasswordReset).toHaveBeenCalledExactlyOnceWith({ token, password: 'Recovery-secret!9841', confirm_password: 'Recovery-secret!9841' });
  await act(async () => gate.resolve({ code: 'password_reset' }));
  expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Your password has been reset. Sign in with your new password.');
  expect(screen.getByTestId('url')).toHaveTextContent(/^\/login$/);
  expect(client.authenticate).not.toHaveBeenCalled();
});

it('validates confirmation and supports showing and hiding passwords', () => {
  mount(`/reset-password#token=${token}`);
  fillPasswords('Recovery-secret!9841', 'different');
  click('Show new password');
  expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'text');
  click('Hide new password');
  expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'password');
  click('Reset Password');
  expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match.');
  expect(client.confirmPasswordReset).not.toHaveBeenCalled();
});

it('shows Django password validation without consuming the form', async () => {
  client.confirmPasswordReset.mockRejectedValueOnce(new HttpError(400, { password: ['This password is too common.'] }));
  mount(`/reset-password#token=${token}`);
  fillPasswords('password');
  click('Reset Password');
  expect(await screen.findByRole('alert')).toHaveTextContent('This password is too common.');
  expect(screen.getByRole('button', { name: 'Reset Password' })).toBeEnabled();
  fillPasswords();
  click('Reset Password');
  await screen.findByRole('heading', { name: 'Welcome back' });
});

it.each([
  ['reset_expired', 'Reset link expired'],
  ['reset_used', 'Reset link already used'],
  ['reset_invalid', 'Invalid reset link'],
])('shows %s and offers a fresh link', async (code, heading) => {
  client.confirmPasswordReset.mockRejectedValueOnce(new HttpError(400, { code, detail: 'private token' }));
  mount(`/reset-password#token=${token}`);
  fillPasswords();
  click('Reset Password');
  await screen.findByRole('heading', { name: heading });
  expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).not.toHaveTextContent('private');
  fireEvent.click(screen.getByRole('link', { name: 'Request a new reset link' }));
  expect(screen.getByRole('heading', { name: 'Forgot password?' })).toBeInTheDocument();
});

it.each(['', '#token=bad', `?token=${token}`])('rejects missing or malformed reset links %s', async suffix => {
  mount(`/reset-password${suffix}`);
  expect(screen.getByRole('heading', { name: 'Invalid reset link' })).toBeInTheDocument();
  expect(client.confirmPasswordReset).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent(/^\/reset-password$/));
});

it('retains the form after a network failure during confirmation', async () => {
  client.confirmPasswordReset.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  mount(`/reset-password#token=${token}`);
  fillPasswords();
  click('Reset Password');
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect.');
  expect(screen.getByLabelText('New password')).toBeEnabled();
});
