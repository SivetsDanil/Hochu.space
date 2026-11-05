"""Сетевые мелочи: адреса компьютера в локальной сети и самоподписанный сертификат для HTTPS."""
import datetime
import ipaddress
import os
import socket


def lan_ips():
    """IP-адреса компьютера в сети, самые вероятные «домашние» — первыми.

    172.16–31.x обычно виртуальные адаптеры (WSL, Docker, VPN), поэтому они в конце.
    """
    primary = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # пакет не отправляется, просто выбирается интерфейс
        primary = s.getsockname()[0]
        s.close()
    except OSError:
        pass
    ips = {primary} if primary else set()
    try:
        ips.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        pass
    ips = {ip for ip in ips if not ip.startswith("127.") and not ip.startswith("169.254.")}

    def rank(ip):
        addr = ipaddress.ip_address(ip)
        if addr in ipaddress.ip_network("192.168.0.0/16"):
            group = 0
        elif addr in ipaddress.ip_network("10.0.0.0/8"):
            group = 1
        elif addr in ipaddress.ip_network("172.16.0.0/12"):
            group = 2
        else:
            group = 3
        return group, ip != primary, ip

    return sorted(ips, key=rank)


def ensure_cert(cert_dir, ips):
    """Самоподписанный сертификат: без HTTPS браузер не даст микрофон и камеру по адресу из сети."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    cert_path = os.path.join(cert_dir, "cert.pem")
    key_path = os.path.join(cert_dir, "key.pem")
    wanted = {ipaddress.ip_address(ip) for ip in ips + ["127.0.0.1"]}

    if os.path.exists(cert_path) and os.path.exists(key_path):
        try:
            with open(cert_path, "rb") as f:
                cert = x509.load_pem_x509_certificate(f.read())
            have = set(cert.extensions.get_extension_for_class(x509.SubjectAlternativeName)
                       .value.get_values_for_type(x509.IPAddress))
            not_after = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after.replace(
                tzinfo=datetime.timezone.utc)
            if wanted <= have and not_after > datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=7):
                return cert_path, key_path
        except Exception:
            pass

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "TabChat local")])
    now = datetime.datetime.now(datetime.timezone.utc)
    san = [x509.DNSName("localhost")] + [x509.IPAddress(ip) for ip in sorted(wanted, key=str)]
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .sign(key, hashes.SHA256())
    )
    os.makedirs(cert_dir, exist_ok=True)
    with open(key_path, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                  serialization.NoEncryption()))
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path
