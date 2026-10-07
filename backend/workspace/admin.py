from django.contrib import admin
from .models import Workspace, Folder, File
# Register your models here.

admin.site.register(Workspace)
admin.site.register(Folder)
admin.site.register(File)
