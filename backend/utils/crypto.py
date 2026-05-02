# backend/utils/crypto.py - 新建文件

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.backends import default_backend
import os
import base64

# Application-specific salt for key derivation.
# Not a password hash — this is a deterministic KDF salt that identifies this application/module.
# Fernet adds a random IV per encryption, so per-value uniqueness is handled separately.
_KDF_SALT = b'vps-dashboard:tg-token-kdf-v1:0'


class CryptoManager:
    """加密管理器"""
    
    def __init__(self, master_key: str = None):
        """
        初始化
        master_key: 主密钥，如果为 None 则从环境变量读取
        """
        if master_key is None:
            master_key = os.getenv('MASTER_ENCRYPTION_KEY')
            if not master_key:
                raise ValueError("MASTER_ENCRYPTION_KEY 环境变量未设置")
        
        self.master_key = master_key
        self.cipher_suite = Fernet(self._derive_key(master_key))
    
    @staticmethod
    def _derive_key(password: str) -> bytes:
        """从密码衍生 Fernet 密钥。

        使用 PBKDF2HMAC（100,000 次迭代）进行密钥拉伸，确保即使 master_key 较短
        也难以暴力破解。Fernet 加密每次使用随机 128-bit IV，保证每条密文唯一。
        salt 为应用特定常量，起域分离作用；此处 master_key 本身是高熵秘密，
        不存在密码字典攻击场景。
        """
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=_KDF_SALT,
            iterations=100000,
            backend=default_backend()
        )
        key = base64.urlsafe_b64encode(kdf.derive(password.encode()))
        return key
    
    def encrypt(self, plaintext: str) -> str:
        """加密字符串"""
        if isinstance(plaintext, str):
            plaintext = plaintext.encode()
        encrypted = self.cipher_suite.encrypt(plaintext)
        return encrypted.decode()
    
    def decrypt(self, ciphertext: str) -> str:
        """解密字符串"""
        if isinstance(ciphertext, str):
            ciphertext = ciphertext.encode()
        try:
            decrypted = self.cipher_suite.decrypt(ciphertext)
            return decrypted.decode()
        except Exception as e:
            raise ValueError(f"解密失败: {e}")
    
    @staticmethod
    def generate_key() -> str:
        """生成新的 Fernet 密钥"""
        return Fernet.generate_key().decode()


# 在模型中使用
from sqlalchemy import TypeDecorator, String

class EncryptedString(TypeDecorator):
    """加密的字符串类型。
    
    透明地对存入数据库的字符串加密、读取时解密。
    若 crypto_manager 为 None（未配置密钥），则行为退化为普通字符串（兼容旧数据）。
    读取时若解密失败（如旧明文数据），则原样返回，保持向后兼容。
    length 默认 512，确保 Fernet 加密后的输出（约 160-220 字符）有足够空间。
    """
    impl = String
    cache_ok = True

    def __init__(self, crypto_manager: CryptoManager = None, length: int = 512):
        super().__init__(length)
        self.crypto_manager = crypto_manager
    
    def process_bind_param(self, value, dialect):
        """存储前加密"""
        if value is None:
            return None
        if self.crypto_manager and value:
            return self.crypto_manager.encrypt(value)
        return value
    
    def process_result_value(self, value, dialect):
        """读取时解密；解密失败时原样返回（兼容历史明文数据）。"""
        if value is None:
            return None
        if self.crypto_manager and value:
            try:
                return self.crypto_manager.decrypt(value)
            except Exception:
                # 兼容性回退：旧明文数据或密钥不匹配时原样返回
                return value
        return value
