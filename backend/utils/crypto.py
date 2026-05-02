# backend/utils/crypto.py - 新建文件

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.backends import default_backend
import logging
import os
import base64

logger = logging.getLogger(__name__)

# Application-specific salt for key derivation.
# Not a password hash — this is a deterministic KDF salt that identifies this application/module.
# Fernet adds a random IV per encryption, so per-value uniqueness is handled separately.
_KDF_SALT = b'vps-dashboard:tg-token-kdf-v1:0'

# Fernet encrypted tokens always start with this base64url prefix (encoding of 0x80 version byte).
_FERNET_PREFIX = 'gAAAAA'


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

    接受一个可调用对象 get_crypto（惰性求值），在每次读写时调用以获取 CryptoManager。
    这样 crypto 密钥可从 Flask app.config 在请求时读取，而不是在模块导入时静态确定。

    Fail-closed 写入策略：
    - 非空值写入时，若 get_crypto() 返回 None（未配置 TELEGRAM_TOKEN_SECRET），
      抛 RuntimeError，拒绝明文落盘。
    - 空字符串和 None 允许直接写入（对应清空 token 操作）。

    读取时若 get_crypto() 返回 None（如只读场景或旧数据迁移），原样返回列值。
    历史明文值（非 Fernet 格式）兼容返回，不抛异常。

    向后兼容：也可直接传入 CryptoManager 实例（会被自动包装成 lambda）。
    """
    impl = String
    cache_ok = True

    def __init__(self, get_crypto, length: int = 512):
        """
        get_crypto: callable() -> CryptoManager | None，或 CryptoManager 实例（向后兼容）。
        """
        super().__init__(length)
        self._get_crypto = get_crypto if callable(get_crypto) else (lambda: get_crypto)

    def process_bind_param(self, value, dialect):
        """存储前加密。未配置密钥时拒绝非空值写入（fail-closed）。"""
        if value is None:
            return None
        if not value:
            # 空字符串允许直接写入（清空 token）
            return value
        crypto = self._get_crypto()
        if crypto is None:
            raise RuntimeError(
                "TELEGRAM_TOKEN_SECRET 未配置，拒绝明文写入 bot_token。"
                "请在环境变量或应用配置中设置 TELEGRAM_TOKEN_SECRET 后重试。"
            )
        return crypto.encrypt(value)

    def process_result_value(self, value, dialect):
        """读取时解密；未配置密钥或历史明文数据时原样返回（向后兼容）。"""
        if value is None:
            return None
        if not value:
            return value
        crypto = self._get_crypto()
        if crypto is None:
            # 未配置密钥：原样返回（只读兼容路径）
            return value
        if not value.startswith(_FERNET_PREFIX):
            # 历史明文数据（迁移前写入）：不尝试解密
            return value
        try:
            return crypto.decrypt(value)
        except Exception as exc:
            logger.error(
                "解密 bot_token 失败（可能密钥变更或数据损坏）: %s", exc
            )
            return value
