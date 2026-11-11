import os, sys, unittest, importlib.util, socket
from unittest.mock import patch
os.environ['REGISTRY_WORK_DIR']='/tmp'
spec=importlib.util.spec_from_file_location('scanner',os.path.join(os.path.dirname(__file__),'../monitor/registry_monitor.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class MonitorTests(unittest.TestCase):
 def test_private_and_mixed_dns_rejected(self):
  for ips in [('127.0.0.1',),('169.254.169.254',),('10.0.0.1',),('93.184.216.34','127.0.0.1')]:
   answers=[(socket.AF_INET,socket.SOCK_STREAM,6,'',(ip,443)) for ip in ips]
   with patch.object(m.socket,'getaddrinfo',return_value=answers):
    with self.assertRaises(ValueError):m.public_target('https://example.com')
 def test_ports_and_credentials(self):
  for url in ['file:///etc/passwd','https://u:p@example.com','http://example.com:3000']:
   with self.assertRaises(ValueError):m.public_target(url)
 def test_discovery_scope(self):
  self.assertTrue(m.owned('https://promo.fitauto.ru/'))
  self.assertFalse(m.owned('https://fitauto.ru.example.com/'))
  self.assertTrue(m.re_asset('/image.svg'))
if __name__=='__main__':unittest.main()
