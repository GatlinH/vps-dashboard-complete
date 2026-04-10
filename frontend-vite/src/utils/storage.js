/**
 * src/utils/storage.js
 * 加密本地存储工具 —— 从 frontend/secure-storage.js 迁移
 */

export class SecureStorage {
  constructor(options = {}) {
    this.algorithm = 'AES-GCM'
    this.keyLength = 256
    this.storageKey = options.storageKey || 'secure_storage'
    this.key = null
    this.init()
  }

  async init() {
    try {
      const storedKey = sessionStorage.getItem('__crypto_key__')
      if (storedKey) {
        this.key = await this._importKey(storedKey)
      } else {
        this.key = await this._generateKey()
        const exportedKey = await crypto.subtle.exportKey('jwk', this.key)
        sessionStorage.setItem('__crypto_key__', JSON.stringify(exportedKey))
      }
    } catch (e) {
      console.warn('密钥初始化失败，使用简单加密:', e)
    }
  }

  async _generateKey() {
    try {
      return await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: this.keyLength },
        true,
        ['encrypt', 'decrypt'],
      )
    } catch (e) {
      console.error('密钥生成失败:', e)
      return null
    }
  }

  async _importKey(keyData) {
    try {
      const jwk = typeof keyData === 'string' ? JSON.parse(keyData) : keyData
      return await crypto.subtle.importKey('jwk', jwk, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
    } catch (e) {
      console.error('密钥导入失败:', e)
      return null
    }
  }

  async encrypt(data) {
    try {
      if (!this.key) return this._simpleEncrypt(data)
      const encoded = new TextEncoder().encode(JSON.stringify(data))
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, encoded)
      const combined = new Uint8Array(iv.length + encrypted.byteLength)
      combined.set(iv)
      combined.set(new Uint8Array(encrypted), iv.length)
      return this._arrayBufferToBase64(combined)
    } catch (e) {
      console.error('加密失败:', e)
      return this._simpleEncrypt(data)
    }
  }

  async decrypt(encrypted) {
    try {
      if (!this.key) return this._simpleDecrypt(encrypted)
      const combined = this._base64ToArrayBuffer(encrypted)
      const iv = combined.slice(0, 12)
      const encryptedData = combined.slice(12)
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.key, encryptedData)
      return JSON.parse(new TextDecoder().decode(decrypted))
    } catch (e) {
      console.error('解密失败:', e)
      return this._simpleDecrypt(encrypted)
    }
  }

  _simpleEncrypt(data) { return btoa(JSON.stringify(data)) }

  _simpleDecrypt(encrypted) {
    try { return JSON.parse(atob(encrypted)) } catch (e) { return null }
  }

  async setEncrypted(key, value) {
    try {
      localStorage.setItem(`${this.storageKey}:${key}`, await this.encrypt(value))
      return true
    } catch (e) { return false }
  }

  async getEncrypted(key) {
    try {
      const enc = localStorage.getItem(`${this.storageKey}:${key}`)
      return enc ? await this.decrypt(enc) : null
    } catch (e) { return null }
  }

  removeEncrypted(key) {
    localStorage.removeItem(`${this.storageKey}:${key}`)
  }

  clearAll() {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key?.startsWith(`${this.storageKey}:`)) localStorage.removeItem(key)
    }
  }

  _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer)
    const chars = []
    for (let i = 0; i < bytes.byteLength; i++) chars.push(String.fromCharCode(bytes[i]))
    return btoa(chars.join(''))
  }

  _base64ToArrayBuffer(base64) {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }

  async hash(data) {
    try {
      const encoded = new TextEncoder().encode(JSON.stringify(data))
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
      return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
    } catch (e) { return null }
  }
}

export default new SecureStorage()
