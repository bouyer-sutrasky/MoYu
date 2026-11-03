import { ApiClientError } from './api';

export function describeAuthError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.message;
  }
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return '操作已取消或超时，请重试。';
    }
    if (error.name === 'SecurityError') {
      return '当前域名与 Passkey 配置不匹配，请确认通过正式 HTTPS 域名访问。';
    }
    if (error.name === 'InvalidStateError') {
      return '该 Passkey 已登记，或认证器状态不允许本次操作。';
    }
    if (error.name === 'NotSupportedError') {
      return '当前浏览器或认证器不支持所需的 Passkey 能力。';
    }
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return '未知错误，请重试。';
}

export function isWebAuthnSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
}
