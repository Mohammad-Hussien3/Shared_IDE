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