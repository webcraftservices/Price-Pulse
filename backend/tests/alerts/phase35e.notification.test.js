'use strict';

const notificationService = require('../../services/notificationService');
const prisma = require('../../lib/prismaClient');
const { Resend } = require('resend');

jest.mock('../../lib/prismaClient', () => ({
  user: {
    findUnique: jest.fn()
  }
}));

jest.mock('resend', () => {
  return {
    Resend: jest.fn().mockImplementation(() => {
      return {
        emails: {
          send: jest.fn()
        }
      };
    })
  };
});

describe('Phase 35E - Notification Delivery', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  const dummyProduct = { name: 'Test Product', model: 'Test Model' };
  const userId = 'user-123';
  const alertId = 'alert-456';

  it('1. returns exact existing noop when API key is missing', async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM_ADDRESS;
    
    const result = await notificationService.notifyPriceDrop(userId, alertId, dummyProduct, 1000, 900);
    
    expect(result).toEqual({
      delivered: false,
      channel: 'noop',
      reason: 'notification_delivery_not_configured'
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(Resend).not.toHaveBeenCalled();
  });

  it('1b. returns exact existing noop when EMAIL_FROM_ADDRESS is missing', async () => {
    process.env.RESEND_API_KEY = 're_123';
    delete process.env.EMAIL_FROM_ADDRESS;
    
    const result = await notificationService.notifyPriceDrop(userId, alertId, dummyProduct, 1000, 900);
    
    expect(result).toEqual({
      delivered: false,
      channel: 'noop',
      reason: 'notification_delivery_not_configured'
    });
  });

  it('2 & 4. returns success and verifies payload when properly configured', async () => {
    process.env.RESEND_API_KEY = 're_123';
    process.env.EMAIL_FROM_ADDRESS = 'alerts@example.com';
    
    prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    
    const sendMock = jest.fn().mockResolvedValue({ data: { id: 'msg_123' }, error: null });
    Resend.mockImplementation(() => ({ emails: { send: sendMock } }));
    
    const result = await notificationService.notifyPriceDrop(userId, alertId, dummyProduct, 1000, 900);
    
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: userId },
      select: { email: true }
    });
    
    expect(sendMock).toHaveBeenCalledWith({
      from: 'alerts@example.com',
      to: 'user@example.com',
      subject: 'Price Drop Alert: Test Product',
      html: expect.stringContaining('Test Product'),
    });
    expect(sendMock.mock.calls[0][0].html).toContain('₹900');
    expect(sendMock.mock.calls[0][0].html).toContain('₹1000');
    
    expect(result).toEqual({
      delivered: true,
      channel: 'email',
      id: 'msg_123'
    });
  });

  it('returns graceful error if user has no email in DB', async () => {
    process.env.RESEND_API_KEY = 're_123';
    process.env.EMAIL_FROM_ADDRESS = 'alerts@example.com';
    
    prisma.user.findUnique.mockResolvedValue({ email: null });
    
    const sendMock = jest.fn();
    Resend.mockImplementation(() => ({ emails: { send: sendMock } }));
    
    const result = await notificationService.notifyPriceDrop(userId, alertId, dummyProduct, 1000, 900);
    
    expect(result).toEqual({
      delivered: false,
      channel: 'email',
      error: 'user_email_not_found'
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('3 & 5. returns graceful error without exposing API key when provider throws', async () => {
    process.env.RESEND_API_KEY = 're_secret_key_123';
    process.env.EMAIL_FROM_ADDRESS = 'alerts@example.com';
    
    prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    
    const sendMock = jest.fn().mockRejectedValue(new Error('Network error from provider'));
    Resend.mockImplementation(() => ({ emails: { send: sendMock } }));
    
    const result = await notificationService.notifyPriceDrop(userId, alertId, dummyProduct, 1000, 900);
    
    expect(result).toEqual({
      delivered: false,
      channel: 'email',
      error: 'Network error from provider'
    });
    
    expect(result.error).not.toContain('re_secret_key_123');
  });

  it('3 & 5. returns graceful error without exposing API key when provider returns explicit error object', async () => {
    process.env.RESEND_API_KEY = 're_secret_key_123';
    process.env.EMAIL_FROM_ADDRESS = 'alerts@example.com';
    
    prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    
    const sendMock = jest.fn().mockResolvedValue({ data: null, error: { message: 'Invalid API key' } });
    Resend.mockImplementation(() => ({ emails: { send: sendMock } }));
    
    const result = await notificationService.notifyPriceDrop(userId, alertId, dummyProduct, 1000, 900);
    
    expect(result).toEqual({
      delivered: false,
      channel: 'email',
      error: 'Invalid API key'
    });
  });

  it('escapes malicious HTML in product name for the email body', async () => {
    process.env.RESEND_API_KEY = 're_123';
    process.env.EMAIL_FROM_ADDRESS = 'alerts@example.com';
    
    prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    
    const sendMock = jest.fn().mockResolvedValue({ data: { id: 'msg_123' }, error: null });
    Resend.mockImplementation(() => ({ emails: { send: sendMock } }));
    
    const maliciousProduct = { name: '<img src=x onerror=alert(1)>' };
    await notificationService.notifyPriceDrop(userId, alertId, maliciousProduct, 1000, 900);
    
    const htmlBody = sendMock.mock.calls[0][0].html;
    expect(htmlBody).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(htmlBody).not.toContain('<img src=x onerror=alert(1)>');
  });
});
