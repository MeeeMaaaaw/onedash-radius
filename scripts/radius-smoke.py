#!/usr/bin/env python3
"""Exercise a real FreeRADIUS server and REST backend; uses only Python stdlib.
Creates and consumes a 60-second test voucher. No real AP or disconnect is tested.
"""
import argparse
import hashlib
import hmac
import json
import os
import socket
import struct
import urllib.request
import uuid


def attr(kind, value):
    if isinstance(value, int):
        value = struct.pack('!I', value)
    elif isinstance(value, str):
        value = value.encode()
    return bytes([kind, len(value) + 2]) + value


def password_attribute(password, secret, authenticator):
    raw = password.encode()
    raw += b'\0' * ((16 - len(raw) % 16) % 16)
    encrypted = b''
    previous = authenticator
    for offset in range(0, len(raw), 16):
        digest = hashlib.md5(secret + previous).digest()
        previous = bytes(a ^ b for a, b in zip(raw[offset:offset + 16], digest))
        encrypted += previous
    return attr(2, encrypted)


def exchange(host, port, secret, code, attributes, password=None):
    identifier = os.urandom(1)[0]
    request_auth = os.urandom(16) if code == 1 else b'\0' * 16
    data = b''.join(attributes)
    if code == 1:
        data += password_attribute(password, secret, request_auth)
        data += attr(80, b'\0' * 16)
    header = struct.pack('!BBH', code, identifier, 20 + len(data))
    if code == 1:
        digest = hmac.new(secret, header + request_auth + data, hashlib.md5).digest()
        data = data[:-16] + digest
    else:
        request_auth = hashlib.md5(header + request_auth + data + secret).digest()
    packet = header + request_auth + data
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(6)
        sock.connect((host, port))
        sock.send(packet)
        reply = sock.recv(4096)
    if len(reply) < 20 or reply[1] != identifier or int.from_bytes(reply[2:4], 'big') != len(reply):
        raise RuntimeError('Invalid RADIUS response framing')
    expected = hashlib.md5(reply[:4] + request_auth + reply[20:] + secret).digest()
    if not hmac.compare_digest(reply[4:20], expected):
        raise RuntimeError('Invalid RADIUS response authenticator')
    values = {}
    offset = 20
    while offset < len(reply):
        kind, length = reply[offset:offset + 2]
        if length < 2 or offset + length > len(reply):
            raise RuntimeError('Malformed RADIUS attribute')
        values[kind] = reply[offset + 2:offset + length]
        offset += length
    return reply[0], values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env', default='/etc/onedash-radius.env')
    parser.add_argument('--secret-file', required=True)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--auth-port', type=int, default=1812)
    parser.add_argument('--acct-port', type=int, default=1813)
    parser.add_argument('--site', default='lab')
    args = parser.parse_args()
    with open(args.env) as f:
        env = dict(line.strip().split('=', 1) for line in f if '=' in line and not line.startswith('#'))
    with open(args.secret_file) as f:
        secret = f.read().strip().encode()
    def api(path, body):
        request = urllib.request.Request('http://127.0.0.1:' + env.get('PORT', '3100') + path,
            data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + env['ADMIN_TOKEN'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)
    voucher = api('/api/admin/vouchers', {'site': args.site, 'seconds': 60})
    code = voucher['code']
    base = [attr(1, code), attr(31, '02:00:00:00:00:01'), attr(32, 'onedash-smoke')]
    def auth(password):
        return exchange(args.host, args.auth_port, secret, 1, base, password)
    def acct(class_id, session_id, status, seconds):
        result, _ = exchange(args.host, args.acct_port, secret, 4, base + [attr(25, class_id), attr(44, session_id), attr(40, status), attr(46, seconds)])
        assert result == 5, f'Expected Accounting-Response, received {result}'
    result, _ = auth('wrong-password')
    assert result == 3, f'Wrong password was not rejected: {result}'
    result, reply = auth(code)
    assert result == 2, f'Expected Access-Accept, received {result}'
    assert int.from_bytes(reply[27], 'big') == 60
    class_id = reply[25]; session_id = uuid.uuid4().hex
    acct(class_id, session_id, 1, 0)
    acct(class_id, session_id, 3, 20)
    acct(class_id, session_id, 3, 20)
    acct(class_id, session_id, 2, 20)
    result, reply = auth(code)
    assert result == 2 and int.from_bytes(reply[27], 'big') == 40, 'Reconnect did not preserve remaining time'
    acct(reply[25], uuid.uuid4().hex, 2, 40)
    result, _ = auth(code)
    assert result == 3, 'Exhausted voucher was accepted'
    print('PASS: wrong password, Access-Accept, Session-Timeout, Class, Start, duplicate Interim, Stop, reconnect remainder, exhausted rejection.')
    print('This verifies server integration only. Complete the physical EAP test before accepting customer coins.')


if __name__ == '__main__':
    main()
