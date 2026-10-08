from rest_framework import serializers
from .models import Workspace, Folder, File


class FileTreeSerializer(serializers.ModelSerializer):
    type = serializers.SerializerMethodField()

    class Meta:
        model = File
        fields = ["id", "name", "type", "language"]

    def get_type(self, obj):
        return "file"


class FolderTreeSerializer(serializers.ModelSerializer):
    type = serializers.SerializerMethodField()
    children = serializers.SerializerMethodField()

    class Meta:
        model = Folder
        fields = ["id", "name", "type", "children"]

    def get_type(self, obj):
        return "folder"

    def get_children(self, obj):
        children = []

        for file in obj.files.all():
            children.append(
                FileTreeSerializer(file).data
            )

        for folder in obj.children.all():
            children.append(
                FolderTreeSerializer(folder).data
            )

        return children


class WorkspaceTreeSerializer(serializers.ModelSerializer):
    children = serializers.SerializerMethodField()

    class Meta:
        model = Workspace
        fields = ["id", "name", "children"]

    def get_children(self, obj):
        children = []

        for file in obj.files.filter(folder__isnull=True):
            children.append(
                FileTreeSerializer(file).data
            )

        for folder in obj.folders.filter(parent__isnull=True):
            children.append(
                FolderTreeSerializer(folder).data
            )

        return children