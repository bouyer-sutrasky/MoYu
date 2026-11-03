import { ApiClientError } from './api';

/**
 * Chinese copy for the shared API error envelope. Server messages stay in
 * English for logs and API consumers, so the web shell translates by status and
 * only falls back to the server text for unexpected failures.
 */
export function describeApiError(error: unknown): string {
  if (error instanceof ApiClientError) {
    switch (error.status) {
      case 401:
        return '登录已失效，请重新登录。';
      case 403:
        return '当前账号没有执行该操作的权限。';
      case 404:
        return '资源不存在，可能已被删除或不再属于当前账号。';
      case 409:
        return '请求与已有记录冲突，请刷新后重试。';
      case 422:
        return '提交的内容不符合接口要求，请检查后重试。';
      case 429:
        return '请求过于频繁，请稍后重试。';
      case 502:
        return '服务端响应不符合共享契约，请稍后重试。';
      case 503:
        return '运行时不可达或暂不可用（HTTP 503），请确认仓库实例已启动后重试。';
      default:
        return `请求失败（HTTP ${error.status}）：${error.message}`;
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return '请求已取消。';
  }
  if (error instanceof TypeError) {
    return '网络连接失败，请检查网络后重试。';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return '未知错误，请重试。';
}

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
