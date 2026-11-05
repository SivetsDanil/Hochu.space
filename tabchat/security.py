"""Пароли и токены сессий."""
import hashlib
import hmac
import secrets

ITERATIONS = 240_000


def hash_password(password):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    return "pbkdf2_sha256$%d$%s$%s" % (ITERATIONS, salt.hex(), dk.hex())


def check_password(password, stored):
    try:
        algo, iters, salt, digest = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(dk.hex(), digest)
    except (ValueError, TypeError):
        return False


def new_token():
    """Возвращает (токен для клиента, хэш для базы). В базе хранится только хэш."""
    token = secrets.token_urlsafe(32)
    return token, token_hash(token)


def token_hash(token):
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()
