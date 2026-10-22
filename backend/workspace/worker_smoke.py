"""Explicit live checks: python -m workspace.worker_smoke (requires prepared worker).

Not discovered by Django's ordinary suite. Uses disposable containers only,
without user accounts, database writes, or production source code.
"""
import asyncio
import unittest

from .worker_client import RemoteInteractiveRunner, request


class LiveWorkerChecks(unittest.IsolatedAsyncioTestCase):
    async def batch(self, language, source):
        result = await request({'type': 'run', 'mode': 'batch', 'language': language, 'source': source})
        self.assertEqual(result['type'], 'result')
        return result['result']

    async def drain(self):
        async with asyncio.timeout(10):
            while (await request({'type': 'health'}))['active']:
                await asyncio.sleep(0.1)

    async def asyncTearDown(self):
        await self.drain()

    async def test_python_c_cpp_and_compiler_runtime_errors(self):
        for language, source in [
            ('python', 'print("hello")'),
            ('c', '#include <stdio.h>\nint main(void){puts("hello");}'),
            ('cpp', '#include <iostream>\nint main(){std::cout << "hello\\n";}'),
        ]:
            with self.subTest(language=language):
                result = await self.batch(language, source)
                self.assertEqual(result['exit_code'], 0, result)
                self.assertEqual(result['stdout'], 'hello\n')
        for language, source, error in [
            ('python', 'print(', 'SyntaxError'),
            ('python', 'raise ValueError("example")', 'ValueError'),
            ('c', 'int main( {', 'error:'),
            ('cpp', 'int main( {', 'error:'),
        ]:
            result = await self.batch(language, source)
            self.assertNotEqual(result['exit_code'], 0)
            self.assertIn(error, result['stderr'])

    async def test_interactive_python_multiple_inputs_c_and_cpp(self):
        for language, source, expected, values in [
            ('python', 'a=input("First: "); b=input("Second: "); print("result", a, b)', 'result 42 43', ['42', '43']),
            ('c', '#include <stdio.h>\nint main(void){int n;printf("Number: ");scanf("%d",&n);printf("result %d\\n",n);}', 'result 42', ['42']),
            ('cpp', '#include <iostream>\nint main(){int n; std::cout<<"Number: "; std::cin>>n; std::cout<<"result "<<n<<"\\n";}', 'result 42', ['42']),
        ]:
            with self.subTest(language=language):
                runner = RemoteInteractiveRunner(language, source)
                try:
                    await runner.start()
                    stream = runner.output_chunks()
                    output = b''
                    for value in values:
                        # Wait for a terminal prompt, not an arbitrary delay.
                        while not output.endswith(b': '):
                            output += await asyncio.wait_for(anext(stream), 15)
                        await runner.write(value + '\r')
                        output += await asyncio.wait_for(anext(stream), 15)
                    async for chunk in stream:
                        output += chunk
                    self.assertIn(expected, output.decode())
                    self.assertEqual(await runner.process.wait(), 0)
                finally:
                    await runner.stop()
                await self.drain()

    async def test_memory_output_timeout_and_filesystem_limits(self):
        result = await self.batch('python', 'a=bytearray(512*1024*1024); print("unexpected")')
        self.assertNotEqual(result['exit_code'], 0)
        self.assertNotIn('unexpected', result['stdout'])
        result = await self.batch('python', 'while True: print("x"*4096)')
        self.assertTrue(result['output_limited'])
        self.assertLessEqual(len(result['stdout'].encode()), 32768)
        result = await self.batch('python', 'while True: pass')
        self.assertTrue(result['timed_out'] or result['exit_code'] != 0)
        result = await self.batch('python', 'import time; time.sleep(30)')
        self.assertTrue(result['timed_out'])
        source = '''import pathlib, os, socket
root=pathlib.Path('/sys/fs/cgroup')
assert int((root/'memory.max').read_text()) == 134217728
assert int((root/'memory.swap.max').read_text()) == 0
assert int((root/'pids.max').read_text()) == 32
q,p=map(int,(root/'cpu.max').read_text().split()); assert q/p == .5
assert os.getuid()==65534
assert not pathlib.Path('/app/.env').exists()
assert not pathlib.Path('/run/shared-ide-worker/token').exists()
assert [name for _,name in socket.if_nameindex()]==['lo']
s=socket.socket(); s.settimeout(.2)
try: s.connect(('1.1.1.1', 443))
except OSError: pass
else: raise AssertionError('network reachable')
try: pathlib.Path('/etc/untrusted').write_text('x')
except OSError: pass
else: raise AssertionError('root writable')
try: pathlib.Path('/tmp/large').write_bytes(b'x'*(2*1024*1024))
except OSError: pass
else: raise AssertionError('file size not limited')
print('isolated')
'''
        result = await self.batch('python', source)
        self.assertEqual(result['exit_code'], 0, result)
        self.assertEqual(result['stdout'], 'isolated\n')

    async def test_concurrent_sessions_stdin_isolation_stop_and_fresh_run(self):
        a = RemoteInteractiveRunner('python', 'print("A",input("A: "))')
        b = RemoteInteractiveRunner('python', 'print("B",input("B: "))')
        try:
            await a.start(); await b.start()
            aa, bb = a.output_chunks(), b.output_chunks()
            self.assertIn(b'A:', await asyncio.wait_for(anext(aa), 10))
            self.assertIn(b'B:', await asyncio.wait_for(anext(bb), 10))
            await a.write('private-A\r')
            out = b''.join([part async for part in aa])
            self.assertIn(b'A private-A', out)
            self.assertNotIn(b'B', out)
            await b.write('private-B\r')
            out = b''.join([part async for part in bb])
            self.assertIn(b'B private-B', out)
            self.assertNotIn(b'private-A', out)
        finally:
            await a.stop(); await b.stop()
        await self.drain()
        waiting = RemoteInteractiveRunner('python', 'input("Waiting: ")')
        try:
            await waiting.start()
            stream = waiting.output_chunks()
            self.assertIn(b'Waiting:', await asyncio.wait_for(anext(stream), 10))
        finally:
            await waiting.stop()
        await self.drain()
        result = await self.batch('python', 'print("fresh")')
        self.assertEqual(result['stdout'], 'fresh\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
