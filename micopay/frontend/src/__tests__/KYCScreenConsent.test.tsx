import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import KYCScreen from '../pages/KYCScreen';
import * as api from '../services/api';
import * as secureStorage from '../services/secureStorage';

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })) },
}));

vi.mock('@capacitor/browser', () => ({ Browser: { open: vi.fn() } }));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

vi.mock('../services/api', () => ({ startKYC: vi.fn(), getKYCStatus: vi.fn() }));

vi.mock('../services/secureStorage', () => ({
  readJSON: vi.fn(),
  writeJSON: vi.fn(),
  removeKey: vi.fn(),
}));

const mockStartKYC = vi.mocked(api.startKYC);

describe('KYCScreen — consentimiento biométrico', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(secureStorage.readJSON).mockResolvedValue(null);
    vi.mocked(api.getKYCStatus).mockResolvedValue({ status: 'pending' });
    mockStartKYC.mockResolvedValue({ onboardingUrl: 'https://verify.didit.me/session/x' } as any);
  });

  it('Didit no se abre sin marcar la casilla', async () => {
    render(<KYCScreen onApproved={vi.fn()} token="t" provider="didit" />);

    const verify = screen.getByRole('button', { name: /kyc.verifyIdentity/ });
    expect(verify).toBeDisabled();
    fireEvent.click(verify);
    expect(mockStartKYC).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(verify).toBeEnabled();
    fireEvent.click(verify);
    await waitFor(() => expect(mockStartKYC).toHaveBeenCalledWith('t', 'didit', undefined));
  });

  it('quien nunca empezó no ve "No se pudo verificar"', async () => {
    vi.mocked(api.getKYCStatus).mockResolvedValue({ status: 'not_started' } as any);
    render(<KYCScreen onApproved={vi.fn()} token="t" provider="didit" />);

    await waitFor(() => expect(api.getKYCStatus).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('kyc.verifyingIdentity')).not.toBeInTheDocument());
    expect(screen.queryByText('kyc.couldNotVerify')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /kyc.retryVerification/ })).not.toBeInTheDocument();
  });

  it('Etherfuse no muestra la casilla', () => {
    render(<KYCScreen onApproved={vi.fn()} token="t" provider="etherfuse" />);

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /kyc.verifyIdentity/ })).toBeEnabled();
  });
});
