// frontend/secure-storage.js - 加密本地存储

class SecureStorage {
    constructor(options = {}) {
        this.algorithm = 'AES-GCM';
        this.keyLength = 256;
        this.storageKey = options.storageKey || 'secure_storage';
        this.key = null;
        this.iv = null;
        
        this.init();
    }

    /**
     * 初始化
     */
    async init() {
        try {
            // 尝试恢复已有的密钥
            const storedKey = sessionStorage.getItem('__crypto_key__');
            if (storedKey) {
                this.key = await this._importKey(storedKey);
            } else {
                // 生成新密钥
                this.key = await this._generateKey();
                const exportedKey = await crypto.subtle.exportKey('jwk', this.key);
                sessionStorage.setItem('__crypto_key__', JSON.stringify(exportedKey));
            }
        } catch (e) {
            console.warn('密钥初始化失败，使用简单加密:', e);
        }
    }

    /**
     * 生成密钥
     */
    async _generateKey() {
        try {
            return await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: this.keyLength },
                true, // extractable
                ['encrypt', 'decrypt']
            );
        } catch (e) {
            console.error('密钥生成失败:', e);
            return null;
        }
    }

    /**
     * 导入密钥
     */
    async _importKey(keyData) {
        try {
            const jwk = typeof keyData === 'string' ? JSON.parse(keyData) : keyData;
            return await crypto.subtle.importKey(
                'jwk',
                jwk,
                { name: 'AES-GCM' },
                true,
                ['encrypt', 'decrypt']
            );
        } catch (e) {
            console.error('密钥导入失败:', e);
            return null;
        }
    }

    /**
     * 加密数据
     */
    async encrypt(data) {
        try {
            if (!this.key) {
                return this._simpleEncrypt(data);
            }

            const encoded = new TextEncoder().encode(JSON.stringify(data));
            const iv = crypto.getRandomValues(new Uint8Array(12));

            const encrypted = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                this.key,
                encoded
            );

            // 组合 IV 和加密数据
            const combined = new Uint8Array(iv.length + encrypted.byteLength);
            combined.set(iv);
            combined.set(new Uint8Array(encrypted), iv.length);

            // 转换为 Base64
            return this._arrayBufferToBase64(combined);
        } catch (e) {
            console.error('加密失败:', e);
            return this._simpleEncrypt(data);
        }
    }

    /**
     * 解密数据
     */
    async decrypt(encrypted) {
        try {
            if (!this.key) {
                return this._simpleDecrypt(encrypted);
            }

            // 从 Base64 转换
            const combined = this._base64ToArrayBuffer(encrypted);
            const iv = combined.slice(0, 12);
            const encryptedData = combined.slice(12);

            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                this.key,
                encryptedData
            );

            const text = new TextDecoder().decode(decrypted);
            return JSON.parse(text);
        } catch (e) {
            console.error('解密失败:', e);
            return this._simpleDecrypt(encrypted);
        }
    }

    /**
     * 简单加密（降级方案）
     */
    _simpleEncrypt(data) {
        const str = JSON.stringify(data);
        return btoa(str); // Base64 编码
    }

    /**
     * 简单解密（降级方案）
     */
    _simpleDecrypt(encrypted) {
        try {
            const str = atob(encrypted);
            return JSON.parse(str);
        } catch (e) {
            console.error('简单解密失败:', e);
            return null;
        }
    }

    /**
     * 设置加密的值
     */
    async setEncrypted(key, value) {
        try {
            const encrypted = await this.encrypt(value);
            localStorage.setItem(`${this.storageKey}:${key}`, encrypted);
            return true;
        } catch (e) {
            console.error('设置加密值失败:', e);
            return false;
        }
    }

    /**
     * 获取加密的值
     */
    async getEncrypted(key) {
        try {
            const encrypted = localStorage.getItem(`${this.storageKey}:${key}`);
            if (!encrypted) return null;
            return await this.decrypt(encrypted);
        } catch (e) {
            console.error('获取加密值失败:', e);
            return null;
        }
    }

    /**
     * 删除加密的值
     */
    removeEncrypted(key) {
        localStorage.removeItem(`${this.storageKey}:${key}`);
    }

    /**
     * 清除所有加密数据
     */
    clearAll() {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (key?.startsWith(`${this.storageKey}:`)) {
                localStorage.removeItem(key);
            }
        }
    }

    /**
     * ArrayBuffer 转 Base64
     */
    _arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Base64 转 ArrayBuffer
     */
    _base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    /**
     * 生成哈希值
     */
    async hash(data) {
        try {
            const encoded = new TextEncoder().encode(JSON.stringify(data));
            const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
            return this._arrayBufferToHex(hashBuffer);
        } catch (e) {
            console.error('哈希计算失败:', e);
            return null;
        }
    }

    /**
     * ArrayBuffer 转 Hex
     */
    _arrayBufferToHex(buffer) {
        const hashArray = Array.from(new Uint8Array(buffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
}

export { SecureStorage };
