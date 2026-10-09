runback:
	cd backend && python manage.py runserver

runfront:
	cd frontend && npm run dev

migrate:
	cd backend && python manage.py migrate

mmigrate:
	cd backend && python manage.py makemigrations

shell:
	cd backend && python manage.py shell

dbshell:
	cd backend && python manage.py dbshell

install-frontend:
	cd frontend && npm install

build-frontend:
	cd frontend && npm run build

runner-images:
	TMPDIR=/tmp podman pull docker.io/library/python:3.12-alpine
	TMPDIR=/tmp podman pull docker.io/library/gcc:14

runner-images-check:
	podman image exists docker.io/library/python:3.12-alpine
	podman image exists docker.io/library/gcc:14
	podman info --format 'rootless={{.Host.Security.Rootless}} graphroot={{.Store.GraphRoot}}'
