import { describe, it, expect } from 'vitest';
import { isPrivateHost } from '../src/tools/web';

describe('Security: SSRF Defenses (isPrivateHost)', () => {
  it('allows standard public domains and IPs', () => {
    expect(isPrivateHost('google.com')).toBe(false);
    expect(isPrivateHost('anthropic.com')).toBe(false);
    expect(isPrivateHost('142.250.190.46')).toBe(false); // Public IP
  });

  it('blocks localhost and zero-addresses', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  it('blocks IPv4 local loopback addresses', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.12.34.56')).toBe(true);
  });

  it('blocks IPv4 private network ranges (RFC 1918)', () => {
    // 10.0.0.0/8
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('10.255.255.255')).toBe(true);
    // 172.16.0.0/12
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    // 192.168.0.0/16
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('192.168.254.254')).toBe(true);
  });

  it('blocks IPv6 loopback', () => {
    expect(isPrivateHost('::1')).toBe(true);
  });
});